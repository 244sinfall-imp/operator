import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import Fastify from "fastify";
import { createTwoFilesPatch } from "diff";

const app = Fastify({ logger: true });

const OPERATOR_TOKEN = process.env.OPERATOR_TOKEN;
if (!OPERATOR_TOKEN) {
  throw new Error("OPERATOR_TOKEN is required");
}

const BIND_HOST = process.env.OPERATOR_BIND_HOST ?? "0.0.0.0";
const PORT = Number(process.env.OPERATOR_PORT ?? "31900");
const MAX_FILE_BYTES = Number(process.env.OPERATOR_MAX_FILE_BYTES ?? String(1024 * 1024));
const SEARCH_RESULT_LIMIT = Number(process.env.OPERATOR_SEARCH_RESULT_LIMIT ?? "200");
const SEARCH_MAX_COLUMNS = Number(process.env.OPERATOR_SEARCH_MAX_COLUMNS ?? "240");
const TRASH_ROOT = expandHome(process.env.OPERATOR_TRASH_DIR ?? "~/.openclaw/trash/bes-operator");
const ALLOWED_ROOTS = parseAllowedRoots(process.env.OPERATOR_ALLOWED_ROOTS);
const OPENCLAW_CLI = process.env.OPERATOR_OPENCLAW_CLI ?? "/home/imp/.nvm/versions/node/v24.15.0/bin/openclaw";
const GATEWAY_SERVICE = process.env.OPERATOR_GATEWAY_SERVICE ?? "openclaw-gateway";
const RESTART_NOTIFY_CHANNEL = process.env.OPERATOR_RESTART_NOTIFY_CHANNEL ?? "telegram";
const RESTART_NOTIFY_ACCOUNT = process.env.OPERATOR_RESTART_NOTIFY_ACCOUNT ?? "self-maintainer";
const RESTART_NOTIFY_TARGET = process.env.OPERATOR_RESTART_NOTIFY_TARGET ?? "355020023";
const RESTART_NOTIFY_MESSAGE = process.env.OPERATOR_RESTART_NOTIFY_MESSAGE
  ?? "Я ожил 🧙‍♂️ OpenClaw gateway перезапустился и снова на связи.";

type FileHash = { sha256: string; exists: boolean };
type ListItem = {
  name: string;
  path: string;
  kind: "file" | "directory";
  size: number;
  mtimeMs: number;
};

type HttpError = Error & { statusCode: number };
type SearchResult = {
  path: string;
  line: number;
  preview: string;
};

type CommandResult = {
  command: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }

  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }

  return value;
}

function parseAllowedRoots(raw: string | undefined): string[] {
  const source = raw?.trim() || "~/.openclaw:/home/imp/.openclaw/workspaces/self-maintainer/repos";
  return source
    .split(":")
    .map((entry) => expandHome(entry.trim()))
    .filter(Boolean)
    .map((entry) => path.resolve(entry));
}

function isInsideRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function ensureAllowed(requestedPath: string, mode: "read" | "write"): Promise<string> {
  const expanded = expandHome(requestedPath);
  const absolute = path.resolve(expanded);

  const stat = await fs.stat(absolute).catch(() => null);
  const resolved = stat
    ? await fs.realpath(absolute)
    : await resolveParentForWrite(absolute);

  const allowed = ALLOWED_ROOTS.some((root) => isInsideRoot(resolved, root));
  if (!allowed) {
    throw makeHttpError(403, "Path is outside allowed roots");
  }

  if (mode === "read" && !stat) {
    throw makeHttpError(404, "Path does not exist");
  }

  return absolute;
}

async function resolveParentForWrite(absolute: string): Promise<string> {
  const parent = path.dirname(absolute);
  const resolvedParent = await fs.realpath(parent).catch(() => null);
  if (!resolvedParent) {
    throw makeHttpError(400, "Parent path does not exist");
  }

  return path.join(resolvedParent, path.basename(absolute));
}

async function hashFile(absolutePath: string): Promise<FileHash> {
  const data = await fs.readFile(absolutePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  });

  if (data === null) {
    return { sha256: "", exists: false };
  }

  return {
    sha256: crypto.createHash("sha256").update(data).digest("hex"),
    exists: true
  };
}

function isBinaryBuffer(buffer: Buffer): boolean {
  return buffer.includes(0);
}

async function readTextFile(absolutePath: string): Promise<{
  content: string;
  sha256: string;
  size: number;
  mtimeMs: number;
}> {
  const stat = await fs.stat(absolutePath);
  if (stat.size > MAX_FILE_BYTES) {
    throw makeHttpError(400, `File is too large for inline editing (${stat.size} bytes)`);
  }

  const buffer = await fs.readFile(absolutePath);
  if (isBinaryBuffer(buffer)) {
    throw makeHttpError(400, "Binary files are not supported by the editor");
  }

  return {
    content: buffer.toString("utf8"),
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    size: stat.size,
    mtimeMs: stat.mtimeMs
  };
}

async function listDirectory(absolutePath: string): Promise<ListItem[]> {
  const entries = await fs.readdir(absolutePath, { withFileTypes: true });
  const items = await Promise.all(entries.map(async (entry) => {
    const itemPath = path.join(absolutePath, entry.name);
    const stat = await fs.stat(itemPath);
    return {
      name: entry.name,
      path: itemPath,
      kind: entry.isDirectory() ? "directory" : "file",
      size: stat.size,
      mtimeMs: stat.mtimeMs
    } satisfies ListItem;
  }));

  return items.sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === "directory" ? -1 : 1;
    }

    return a.name.localeCompare(b.name);
  });
}

async function moveToTrash(absolutePath: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destination = path.join(TRASH_ROOT, stamp, path.relative("/", absolutePath));
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.rename(absolutePath, destination);
  return destination;
}

function makeHttpError(statusCode: number, message: string): HttpError {
  const error = new Error(message) as HttpError;
  error.statusCode = statusCode;
  return error;
}

function parseSearchResult(line: string): SearchResult | null {
  const firstColon = line.indexOf(":");
  const secondColon = line.indexOf(":", firstColon + 1);
  if (firstColon === -1 || secondColon === -1) {
    return null;
  }

  return {
    path: line.slice(0, firstColon),
    line: Number(line.slice(firstColon + 1, secondColon)),
    preview: line.slice(secondColon + 1)
  };
}

async function searchFiles(query: string, root: string): Promise<SearchResult[]> {
  return new Promise((resolve, reject) => {
    const results: SearchResult[] = [];
    const child = spawn("rg", [
      "--line-number",
      "--hidden",
      "--color",
      "never",
      "--max-columns",
      String(SEARCH_MAX_COLUMNS),
      "--max-columns-preview",
      "--glob",
      "!.git",
      "--smart-case",
      "--",
      query,
      root
    ]);
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let stoppedAtLimit = false;

    function appendResults(chunk: string): void {
      stdoutBuffer += chunk;
      let newlineIndex = stdoutBuffer.indexOf("\n");

      while (newlineIndex !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex);
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        const result = parseSearchResult(line);
        if (result) {
          results.push(result);
        }

        if (results.length >= SEARCH_RESULT_LIMIT) {
          stoppedAtLimit = true;
          child.kill();
          return;
        }

        newlineIndex = stdoutBuffer.indexOf("\n");
      }
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", appendResults);
    child.stderr.on("data", (chunk: string) => {
      stderrBuffer = (stderrBuffer + chunk).slice(-4096);
    });
    child.on("error", (error) => {
      reject(makeHttpError(500, error.message));
    });
    child.on("close", (code) => {
      if (!stoppedAtLimit && stdoutBuffer) {
        const result = parseSearchResult(stdoutBuffer);
        if (result) {
          results.push(result);
        }
      }

      if (stoppedAtLimit || code === 0 || code === 1) {
        resolve(results.slice(0, SEARCH_RESULT_LIMIT));
        return;
      }

      reject(makeHttpError(500, stderrBuffer.trim() || `Search failed with exit code ${code}`));
    });
  });
}

async function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-4096);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4096);
    });
    child.on("error", (error) => {
      reject(makeHttpError(500, error.message));
    });
    child.on("close", (exitCode, signal) => {
      resolve({
        command: [command, ...args].join(" "),
        exitCode,
        signal,
        stdout: stdout.trim(),
        stderr: stderr.trim()
      });
    });
  });
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function buildRestartGatewayScript(): string {
  const statusCommand = [shellSingleQuote(OPENCLAW_CLI), "status", "--deep"].join(" ");
  const notifyCommand = [
    shellSingleQuote(OPENCLAW_CLI),
    "message",
    "send",
    "--channel",
    shellSingleQuote(RESTART_NOTIFY_CHANNEL),
    "--account",
    shellSingleQuote(RESTART_NOTIFY_ACCOUNT),
    "--target",
    shellSingleQuote(RESTART_NOTIFY_TARGET),
    "--message",
    shellSingleQuote(RESTART_NOTIFY_MESSAGE)
  ].join(" ");

  return [
    "set -eu",
    `systemctl --user restart ${shellSingleQuote(GATEWAY_SERVICE)}`,
    "ready=0",
    "for _ in $(seq 1 30); do",
    `  if ${statusCommand} >/dev/null 2>&1; then ready=1; break; fi`,
    "  sleep 2",
    "done",
    "if [ \"$ready\" -ne 1 ]; then exit 1; fi",
    notifyCommand
  ].join("\n");
}

app.addHook("onRequest", async (request) => {
  const token = request.headers["x-operator-token"];
  if (token !== OPERATOR_TOKEN) {
    throw makeHttpError(401, "Unauthorized");
  }
});

app.get("/health", async () => ({
  ok: true,
  roots: ALLOWED_ROOTS
}));

app.get("/api/v1/roots", async () => ({
  roots: ALLOWED_ROOTS.map((root) => ({
    label: root,
    path: root
  }))
}));

app.get<{ Querystring: { path: string } }>("/api/v1/list", async (request) => {
  const absolute = await ensureAllowed(request.query.path, "read");
  const stat = await fs.stat(absolute);
  if (!stat.isDirectory()) {
    throw makeHttpError(400, "Requested path is not a directory");
  }

  return {
    path: absolute,
    parent: absolute === path.parse(absolute).root ? null : path.dirname(absolute),
    items: await listDirectory(absolute)
  };
});

app.get<{ Querystring: { path: string } }>("/api/v1/file", async (request) => {
  const absolute = await ensureAllowed(request.query.path, "read");
  const stat = await fs.stat(absolute);
  if (!stat.isFile()) {
    throw makeHttpError(400, "Requested path is not a file");
  }

  return {
    path: absolute,
    ...await readTextFile(absolute)
  };
});

app.post<{ Body: { path: string; newContent: string } }>("/api/v1/diff", async (request) => {
  const absolute = await ensureAllowed(request.body.path, "write");
  const current = await fs.readFile(absolute, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return "";
    }

    throw error;
  });

  return {
    patch: createTwoFilesPatch(absolute, absolute, current, request.body.newContent, "current", "edited")
  };
});

app.post<{ Body: { path: string; newContent: string; expectedSha256?: string } }>("/api/v1/write", async (request) => {
  const absolute = await ensureAllowed(request.body.path, "write");
  const fileState = await hashFile(absolute);

  if ((request.body.expectedSha256 ?? "") !== fileState.sha256) {
    throw makeHttpError(409, "File changed on disk; reload before saving");
  }

  await fs.writeFile(absolute, request.body.newContent, "utf8");
  return {
    ok: true,
    path: absolute,
    ...await hashFile(absolute)
  };
});

app.post<{ Body: { path: string } }>("/api/v1/trash", async (request) => {
  const absolute = await ensureAllowed(request.body.path, "write");
  return {
    ok: true,
    trashedTo: await moveToTrash(absolute)
  };
});

app.post<{ Body: { query: string; root?: string } }>("/api/v1/search", async (request) => {
  const root = request.body.root ? await ensureAllowed(request.body.root, "read") : ALLOWED_ROOTS[0];
  if (!root) {
    throw makeHttpError(500, "No allowed roots configured");
  }

  return {
    results: await searchFiles(request.body.query, root)
  };
});

app.post("/api/v1/openclaw/gateway/restart", async () => {
  const unitName = `bes-operator-openclaw-restart-${Date.now()}`;
  const result = await runCommand("systemd-run", [
    "--user",
    "--collect",
    "--unit",
    unitName,
    "--description",
    "Bes Operator OpenClaw gateway restart with notification",
    "bash",
    "-lc",
    buildRestartGatewayScript()
  ]);
  if (result.exitCode !== 0) {
    throw makeHttpError(500, result.stderr || `Command failed: ${result.command}`);
  }

  return {
    ok: true,
    command: result.command,
    unit: unitName,
    scheduledAt: new Date().toISOString(),
    notify: {
      channel: RESTART_NOTIFY_CHANNEL,
      account: RESTART_NOTIFY_ACCOUNT,
      target: RESTART_NOTIFY_TARGET
    }
  };
});

app.setErrorHandler((error: unknown, _request, reply) => {
  const typedError = error as Partial<HttpError>;
  const statusCode = typeof typedError.statusCode === "number"
    ? typedError.statusCode
    : 500;
  reply.code(statusCode).send({ message: typedError.message ?? "Internal server error" });
});

app.listen({ host: BIND_HOST, port: PORT }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
