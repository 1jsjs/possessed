// Canary listener - HTTP server to record canary hits

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve as resolvePath, sep } from "node:path";
import { CanaryHit } from "./types.js";

const MAX_BODY_SIZE = 65536; // 64 KiB

/**
 * Starts an HTTP listener on 127.0.0.1 with an OS-assigned port.
 * Returns the port and a stop function that returns all recorded hits.
 */
export async function startListener(): Promise<{
  port: number;
  stop: () => Promise<CanaryHit[]>;
  /** Serve files under `dir` for GET requests, passing text through `render` (templating). */
  serve: (dir: string, render: (text: string) => string) => void;
}> {
  const hits: CanaryHit[] = [];
  let site: { dir: string; render: (text: string) => string } | undefined;

  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      // Record the hit
      const timestamp = new Date().toISOString();
      const method = req.method || "GET";
      const url = req.url || "";
      const [path, query] = url.split("?");

      // Read body with limit
      const chunks: Buffer[] = [];
      let bodyTruncated = false;

      req.on("data", (chunk: Buffer) => {
        const currentSize = chunks.reduce((acc, c) => acc + c.length, 0);
        if (currentSize >= MAX_BODY_SIZE) {
          bodyTruncated = true;
          return;
        }
        const remaining = MAX_BODY_SIZE - currentSize;
        if (chunk.length > remaining) {
          // Take only what fits
          chunks.push(chunk.slice(0, remaining));
          bodyTruncated = true;
        } else {
          chunks.push(chunk);
        }
      });

      req.on("end", () => {
        let body = "";
        if (chunks.length > 0) {
          const fullBody = Buffer.concat(chunks);
          // bodyTruncated is set when we hit the limit during data collection
          // so we use the full buffer which is already limited
          body = fullBody.toString("utf-8");
        }

        // Log warning if host is not 127.0.0.1 (but still record the hit)
        const host = req.headers.host || "";
        if (!host.startsWith("127.0.0.1") && !host.startsWith("localhost:")) {
          console.warn(`[listener] Warning: request from non-127.0.0.1 host: ${host}`);
        }

        hits.push({
          kind: "canary-hit",
          timestamp,
          method,
          path: path || "",
          query: query || "",
          body,
        });

        if (site && method === "GET") {
          servePage(site, path || "/", res).catch(() => {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("OK");
          });
          return;
        }
        // Always respond 200 OK
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("OK");
      });

      req.on("error", (err) => {
        console.error("[listener] Request error:", err);
      });
    });

    server.on("error", reject);

    // Bind exclusively to 127.0.0.1
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to get server address"));
        return;
      }

      const port = address.port;

      resolve({
        port,
        serve: (dir, render) => {
          site = { dir: resolvePath(dir), render };
        },
        stop: async (): Promise<CanaryHit[]> => {
          return new Promise((resolveStops) => {
            server.close(() => {
              resolveStops([...hits]); // Return a copy
            });
          });
        },
      });
    });
  });
}
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".sh": "text/x-shellscript; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
};

/** Serves one file from the site folder; unknown paths fall through to the plain "OK" answer. */
async function servePage(
  site: { dir: string; render: (text: string) => string },
  urlPath: string,
  res: ServerResponse
): Promise<void> {
  let file = normalize(join(site.dir, decodeURIComponent(urlPath)));
  if (file !== site.dir && !file.startsWith(site.dir + sep)) throw new Error("outside site");
  if ((await stat(file)).isDirectory()) file = join(file, "index.html");
  const text = await readFile(file, "utf-8");
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "text/plain; charset=utf-8" });
  res.end(site.render(text));
}
