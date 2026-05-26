import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = Fastify({ logger: true });
const PORT = Number(process.env.PORT ?? "3000");
const HOST = process.env.HOST ?? "0.0.0.0";
const AGENT_BASE_URL = process.env.AGENT_BASE_URL;
const AGENT_SHARED_TOKEN = process.env.AGENT_SHARED_TOKEN;

if (!AGENT_BASE_URL || !AGENT_SHARED_TOKEN) {
  throw new Error("AGENT_BASE_URL and AGENT_SHARED_TOKEN are required");
}

app.register(fastifyStatic, {
  root: path.join(__dirname, "public")
});

app.get("/health", async () => ({
  ok: true
}));

app.all("/api/*", async (request, reply) => {
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
