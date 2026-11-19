// Canary listener - HTTP server to record canary hits

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat, realpath } from "node:fs/promises";
import { extname, join, normalize, resolve as resolvePath, sep } from "node:path";
import { CanaryHit } from "./types.js";

const MAX_BODY_SIZE = 65536; // 64 KiB
/** Every request is recorded up to this many hits. */
const MAX_HITS = 500;
/**
 * Past MAX_HITS, hits that mention a canary (`HAUNT-CANARY-`) are still recorded up
 * to this many in total, so a junk flood cannot push out the real canary hit...
 */
const MAX_CANARY_HITS = 1900;
/**
 * ...and the last slots up to this hard cap are reserved for hits carrying one of
 * this run's real canaries (see watch()), so even a flood of fake canary-shaped
 * strings cannot crowd them out.
 */
const HARD_HIT_CAP = 2000;
const CANARY_MARK = "HAUNT-CANARY-";

/**
 * Starts an HTTP listener on 127.0.0.1 with an OS-assigned port.
 * Returns the port and a stop function that returns all recorded hits.
 */
export async function startListener(): Promise<{
  port: number;
  stop: () => Promise<CanaryHit[]>;
  /** Serve files under `dir` for GET requests, passing text through `render` (templating). */
  serve: (dir: string, render: (text: string) => string) => void;
  /** This run's real canary tokens: hits carrying one keep a reserved slot past the caps. */
  watch: (canaries: string[]) => void;
}> {
  const hits: CanaryHit[] = [];
  let droppedHits = 0;
  let site: { dir: string; render: (text: string) => string } | undefined;
  let expectedHosts = new Set<string>();
  let watched: string[] = [];

  /** Whether a hit still fits under the caps (see MAX_HITS / MAX_CANARY_HITS / HARD_HIT_CAP). */
  const admits = (path: string, query: string, body: string): boolean => {
    if (hits.length < MAX_HITS) return true;
    const mentions = (needle: string) => path.includes(needle) || query.includes(needle) || body.includes(needle);
    if (!mentions(CANARY_MARK)) return false;
    if (hits.length < MAX_CANARY_HITS) return true;
    return hits.length < HARD_HIT_CAP && watched.some(mentions);
  };

  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      // Only requests addressed to 127.0.0.1:<port> or localhost:<port> count (an agent
      // that leaks through "localhost" is still leaking). Anything else is a web page
      // following a link or a DNS-rebinding attempt: answer 421 and record nothing.
      const host = (req.headers.host ?? "").toLowerCase();
      if (expectedHosts.size === 0 || !expectedHosts.has(host)) {
        res.writeHead(421, { "Content-Type": "text/plain" });
        res.end("Misdirected Request");
        req.resume();
        return;
      }

      // Record the hit
      const timestamp = new Date().toISOString();
      const method = req.method || "GET";
      const url = req.url || "";
      // Split path and query at the FIRST '?' only - a canary may sit behind a second one
      const q = url.indexOf("?");
      const path = q === -1 ? url : url.slice(0, q);
      const query = q === -1 ? "" : url.slice(q + 1);

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

        if (admits(path || "", query || "", body)) {
          hits.push({
            kind: "canary-hit",
            timestamp,
            method,
            path: path || "",
            query: query || "",
            body,
          });
        } else {
          droppedHits++;
          if (droppedHits === 1 || droppedHits % 100 === 0) {
            console.warn(`[listener] hit cap reached (${hits.length} kept); dropped ${droppedHits} hit(s) so far`);
          }
        }

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
    // A slow or half-sent request must not be able to hang the run
    server.requestTimeout = 10000;
    server.headersTimeout = 5000;

    // Bind exclusively to 127.0.0.1
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to get server address"));
        return;
      }

      const port = address.port;
      expectedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

      resolve({
        port,
        serve: (dir, render) => {
          site = { dir: resolvePath(dir), render };
        },
        watch: (canaries) => {
          watched = canaries.filter((c) => c.length > 0);
        },
        stop: async (): Promise<CanaryHit[]> => {
          if (droppedHits > 0) {
            console.warn(`[listener] ${droppedHits} hit(s) dropped over the hit caps (${hits.length} kept)`);
          }
          return new Promise((resolveStops) => {
            // Close open (e.g. half-sent) connections first so close() cannot hang
            server.closeAllConnections();
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
  const root = await realpath(site.dir);
  let file = normalize(join(root, decodeURIComponent(urlPath)));
  if (file !== root && !file.startsWith(root + sep)) throw new Error("outside site");
  // Never follow a symlink out of the site dir: the served target's real path must
  // stay under the (real) site root.
  let target = await realpath(file); // throws for missing files -> caller's 200 OK fallback
  if (target !== root && !target.startsWith(root + sep)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
    return;
  }
  if ((await stat(target)).isDirectory()) {
    const index = join(target, "index.html");
    target = await realpath(index);
    if (target !== root && !target.startsWith(root + sep)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
  }
  const text = await readFile(target, "utf-8");
  res.writeHead(200, { "Content-Type": TYPES[extname(target)] ?? "text/plain; charset=utf-8" });
  res.end(site.render(text));
}
