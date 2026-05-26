import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = Fastify({ logger: true });
const PORT = Number(process.env.PORT ?? "3000");
const HOST = process.env.HOST ?? "0.0.0.0";
const SESSION_COOKIE = "bes_operator_session";
const SESSION_TTL_SECONDS = Number(process.env.OPERATOR_SESSION_TTL_SECONDS ?? String(60 * 60 * 24 * 7));

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

const AGENT_BASE_URL = requireEnv("AGENT_BASE_URL");
const AGENT_SHARED_TOKEN = requireEnv("AGENT_SHARED_TOKEN");
const OPERATOR_UI_PASSWORD_HASH = requireEnv("OPERATOR_UI_PASSWORD_HASH");
const OPERATOR_SESSION_SECRET = requireEnv("OPERATOR_SESSION_SECRET");

type SessionPayload = {
  exp: number;
};

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) {
    return {};
  }

  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf("=");
        if (separator === -1) {
          return [part, ""];
        }

        return [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))];
      })
  );
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signValue(value: string): string {
  return crypto.createHmac("sha256", OPERATOR_SESSION_SECRET).update(value).digest("base64url");
}

function serializeCookie(name: string, value: string, maxAgeSeconds: number): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Secure",
    `Max-Age=${maxAgeSeconds}`
  ];
  return parts.join("; ");
}

function clearCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`;
}

function issueSessionCookie(): string {
  const payload: SessionPayload = {
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = signValue(encodedPayload);
  return serializeCookie(SESSION_COOKIE, `${encodedPayload}.${signature}`, SESSION_TTL_SECONDS);
}

function readSessionFromCookie(rawCookie: string | undefined): SessionPayload | null {
  const cookies = parseCookies(rawCookie);
  const sessionValue = cookies[SESSION_COOKIE];
  if (!sessionValue) {
    return null;
  }

  const separator = sessionValue.lastIndexOf(".");
  if (separator === -1) {
    return null;
  }

  const encodedPayload = sessionValue.slice(0, separator);
  const signature = sessionValue.slice(separator + 1);
  const expectedSignature = signValue(encodedPayload);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (signatureBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null;
  }

  const payload = JSON.parse(base64UrlDecode(encodedPayload)) as SessionPayload;
  if (!payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) {
    return null;
  }

  return payload;
}

function verifyPassword(candidate: string): boolean {
  const [scheme, salt, expected] = OPERATOR_UI_PASSWORD_HASH.split("$");
  if (scheme !== "scrypt" || !salt || !expected) {
    throw new Error("OPERATOR_UI_PASSWORD_HASH must be in scrypt$salt$hash format");
  }

  const derived = crypto.scryptSync(candidate, salt, 64).toString("hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  const derivedBuffer = Buffer.from(derived, "hex");
  return expectedBuffer.length === derivedBuffer.length && crypto.timingSafeEqual(expectedBuffer, derivedBuffer);
}

function requireAuthenticatedRequest(rawCookie: string | undefined): void {
  const session = readSessionFromCookie(rawCookie);
  if (!session) {
    const error = new Error("Unauthorized") as Error & { statusCode?: number };
    error.statusCode = 401;
    throw error;
  }
}

app.register(fastifyStatic, {
  root: path.join(__dirname, "public")
});

app.get("/health", async () => ({
  ok: true
}));

app.get("/auth/session", async (request, reply) => {
  const session = readSessionFromCookie(request.headers.cookie);
  if (!session) {
    reply.code(401);
    return { authenticated: false };
  }

  return {
    authenticated: true,
    expiresAt: new Date(session.exp * 1000).toISOString()
  };
});

app.post<{ Body: { password?: string } }>("/auth/login", async (request, reply) => {
  const password = request.body?.password ?? "";
  if (!verifyPassword(password)) {
    reply.code(401);
    return { authenticated: false, message: "Invalid password" };
  }

  reply.header("set-cookie", issueSessionCookie());
  return { authenticated: true };
});

app.post("/auth/logout", async (_request, reply) => {
  reply.header("set-cookie", clearCookie(SESSION_COOKIE));
  return { ok: true };
});

app.all("/api/*", async (request, reply) => {
  requireAuthenticatedRequest(request.headers.cookie);
  const targetPath = request.url.replace(/^\/api/, "/api");
  const body = request.method === "GET" || request.method === "HEAD"
    ? null
    : JSON.stringify(request.body ?? {});
  const response = await fetch(`${AGENT_BASE_URL}${targetPath}`, {
    method: request.method,
    headers: {
      "content-type": request.headers["content-type"] ?? "application/json",
      "x-operator-token": AGENT_SHARED_TOKEN
    },
    body
  });

  const text = await response.text();
  reply.code(response.status);
  reply.header("content-type", response.headers.get("content-type") ?? "application/json");
  return text;
});

app.setNotFoundHandler(async (_request, reply) => {
  const html = await fs.readFile(path.join(__dirname, "public", "index.html"), "utf8");
  reply.type("text/html").send(html);
});

app.listen({ host: HOST, port: PORT }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
