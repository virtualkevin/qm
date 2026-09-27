import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { TodoStorage } from "./storage.mjs";

const storage = new TodoStorage();
const indexPath = fileURLToPath(new URL("./index.html", import.meta.url));

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw Object.assign(new Error("Request body too large"), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Invalid JSON body"), { status: 400 });
  }
}

function validateTitle(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 500) return false;
  return true;
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    if (request.method === "GET" && url.pathname === "/api/todos") {
      return sendJson(response, 200, { todos: storage.list() });
    }
    if (request.method === "POST" && url.pathname === "/api/todos") {
      const body = await readJson(request);
      if (!body || typeof body !== "object" || Array.isArray(body) || !validateTitle(body.title)) {
        return sendJson(response, 400, { error: "title must be a non-empty string of at most 500 characters" });
      }
      return sendJson(response, 201, { todo: storage.create(body.title.trim()) });
    }
    const match = url.pathname.match(/^\/api\/todos\/([^/]+)$/);
    if (match && request.method === "PATCH") {
      const body = await readJson(request);
      if (!body || typeof body !== "object" || Array.isArray(body))
        return sendJson(response, 400, { error: "body must be an object" });
      const keys = Object.keys(body);
      if (!keys.length || keys.some((key) => !["title", "done"].includes(key)))
        return sendJson(response, 400, { error: "provide title and/or done only" });
      if ("title" in body && !validateTitle(body.title))
        return sendJson(response, 400, { error: "title must be a non-empty string of at most 500 characters" });
      if ("done" in body && typeof body.done !== "boolean")
        return sendJson(response, 400, { error: "done must be a boolean" });
      const todo = storage.update(decodeURIComponent(match[1]), body);
      if (!todo) return sendJson(response, 404, { error: "todo not found" });
      return sendJson(response, 200, { todo });
    }
    if (match && request.method === "DELETE") {
      if (!storage.delete(decodeURIComponent(match[1]))) return sendJson(response, 404, { error: "todo not found" });
      return sendJson(response, 200, { ok: true });
    }
    if (request.method === "GET" && url.pathname === "/") {
      const html = await readFile(indexPath);
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return response.end(html);
    }
    return sendJson(response, 404, { error: "not found" });
  } catch (error) {
    return sendJson(response, error.status || 500, { error: error.status ? error.message : "internal server error" });
  }
});

server.listen(Number(process.env.PORT || 3000), "0.0.0.0");
