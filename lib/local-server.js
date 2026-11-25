// Optional localhost web access to the same app. Binds to 127.0.0.1 only, rejects
// any Host/Origin other than localhost, and requires a per-launch token on API calls.
import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "./hub.js";

const MAX_BODY = 40 * 1024 * 1024; // room for attachments sent as base64 (limits enforced in hub.js)

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

export function startLocalServer({ hub, publicDir, port, host = "127.0.0.1" }) {
  const token = randomBytes(32).toString("base64url");
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const STATIC = {
    "/": { file: "index.html", type: "text/html; charset=utf-8" },
    "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
    "/mascot.js": { file: "mascot.js", type: "text/javascript; charset=utf-8" },
    "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
  };

  const tokenOk = (provided) => {
    if (typeof provided !== "string") return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const sendJson = (res, status, body) => {
    res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };

  const readJson = (req) =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on("data", (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new HttpError(413, "Request too large."));
          req.destroy();
        } else {
          chunks.push(c);
        }
      });
      req.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
        } catch {
          reject(new HttpError(400, "Invalid JSON."));
        }
      });
      req.on("error", reject);
    });

  // Streams a reply as SSE. Validation errors thrown before the first event
  // are returned as normal JSON errors (headers are only sent on first write).
  async function streamChat(req, res) {
    const body = await readJson(req);
    const controller = new AbortController();
    let finished = false;
    let clientGone = false;
    res.on("close", () => {
      if (!finished) {
        clientGone = true;
        controller.abort();
      }
    });
    let started = false;
    const write = (obj) => {
      if (!started) {
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          "Content-Type": "text/event-stream; charset=utf-8",
          Connection: "keep-alive",
        });
        started = true;
      }
      if (!clientGone && !res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };
    try {
      await hub.chat(body, write, controller.signal);
    } finally {
      finished = true;
      if (started) res.end();
    }
  }

  async function serveStatic(res, pathname) {
    const entry = STATIC[pathname];
    if (!entry) return sendJson(res, 404, { error: "Not found." });
    let text = await readFile(path.join(publicDir, entry.file), "utf8");
    if (entry.file === "index.html") text = text.replace("__APP_TOKEN__", token);
    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": entry.type });
    res.end(text);
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!allowedHosts.has(req.headers.host)) return sendJson(res, 403, { error: "Forbidden host." });
      const origin = req.headers.origin;
      if (origin && !allowedOrigins.has(origin)) return sendJson(res, 403, { error: "Forbidden origin." });

      const url = new URL(req.url, `http://${host}:${port}`);
      const p = url.pathname;

      if (req.method === "GET" && !p.startsWith("/api/")) return await serveStatic(res, p);
      if (!tokenOk(req.headers["x-app-token"])) return sendJson(res, 401, { error: "Unauthorized." });

      if (req.method === "GET" && p === "/api/status") return sendJson(res, 200, hub.status());
      if (req.method === "POST" && p === "/api/key") {
        const body = await readJson(req);
        return sendJson(res, 200, await hub.saveKey(body.apiKey));
      }
      if (req.method === "DELETE" && p === "/api/key") return sendJson(res, 200, await hub.deleteKey());
      if (req.method === "POST" && p === "/api/profile") {
        const body = await readJson(req);
        return sendJson(res, 200, await hub.setName(body.name));
      }
      if (req.method === "GET" && p === "/api/models") {
        return sendJson(res, 200, await hub.models(url.searchParams.get("refresh") === "1"));
      }
      if (req.method === "POST" && p === "/api/chat") return await streamChat(req, res);
      return sendJson(res, 404, { error: "Not found." });
    } catch (err) {
      if (res.headersSent) return res.end();
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof HttpError ? err.message : "Internal error.";
      if (status === 500) console.error("local-server error:", err?.message);
      return sendJson(res, status, { error: message });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      resolve({
        url: `http://localhost:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
