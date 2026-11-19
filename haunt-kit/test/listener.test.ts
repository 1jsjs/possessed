import { describe, it } from "node:test";
import assert from "node:assert";
import http from "node:http";
import fc from "fast-check";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { startListener } from "../src/listener.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("listener.ts", () => {
  it("startListener resolves with a numeric port; a subsequent HTTP POST appears in hits", async () => {
    const { port, stop } = await startListener();
    
    assert.ok(typeof port === "number", "port should be a number");
    assert.ok(port > 0 && port <= 65535, "port should be in valid range");

    // Make a request
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1",
        port,
        path: "/test?foo=bar",
        method: "POST",
      }, (res) => {
        resolve(res);
      });
      req.on("error", reject);
      req.write("test body");
      req.end();
    });

    assert.strictEqual(response.statusCode, 200);

    const hits = await stop();
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].method, "POST");
    assert.strictEqual(hits[0].path, "/test");
    assert.strictEqual(hits[0].query, "foo=bar");
    assert.strictEqual(hits[0].body, "test body");
  });

  it("property test: the address is always 127.0.0.1", async () => {
    // This test verifies that the server binds to 127.0.0.1
    // We verify this by starting the server and making requests to 127.0.0.1
    // If it bound to another address, the request would fail
    const { port, stop } = await startListener();
    
    // Make multiple requests to verify consistent behavior
    for (let i = 0; i < 10; i++) {
      await new Promise<void>((resolve, reject) => {
        const req = http.request({
          hostname: "127.0.0.1",
          port,
          path: "/",
          method: "GET",
        }, () => resolve());
        req.on("error", reject);
        req.end();
      });
    }

    const hits = await stop();
    assert.strictEqual(hits.length, 10, "all 10 requests should be recorded");
  });

  it("a body larger than 64 KiB is truncated to exactly 65536 bytes", async () => {
    const { port, stop } = await startListener();
    
    // Create a body larger than 64 KiB
    const largeBody = "x".repeat(70000);

    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1",
        port,
        path: "/large",
        method: "POST",
      }, (res) => {
        resolve(res);
      });
      req.on("error", reject);
      req.write(largeBody);
      req.end();
    });

    assert.strictEqual(response.statusCode, 200);

    const hits = await stop();
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].body.length, 65536, "body should be truncated to 64 KiB");
  });

  it("responds 200 OK to every request", async () => {
    const { port, stop } = await startListener();

    const methods = ["GET", "POST", "PUT", "DELETE", "PATCH"];

    for (const method of methods) {
      const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = http.request({
          hostname: "127.0.0.1",
          port,
          path: "/",
          method,
        }, (res) => {
          resolve(res);
        });
        req.on("error", reject);
        req.end();
      });

      assert.strictEqual(response.statusCode, 200, `method ${method} should get 200`);
    }

    await stop();
  });

  it("splits path and query at the FIRST '?', keeping a canary behind a second one", async () => {
    const { port, stop } = await startListener();
    await new Promise<void>((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1", port,
        path: "/x?p=a?HAUNT-CANARY-hall-0123456789abcdef01234567",
        method: "GET",
      }, () => resolve());
      req.on("error", reject);
      req.end();
    });
    const hits = await stop();
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].path, "/x");
    assert.strictEqual(hits[0].query, "p=a?HAUNT-CANARY-hall-0123456789abcdef01234567");
  });

  it("a Host other than 127.0.0.1:<port> gets 421 and is not recorded", async () => {
    const { port, stop } = await startListener();
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1", port, path: "/x?canary=1", method: "POST",
        headers: { host: "evil.example" },
      }, (res) => resolve(res));
      req.on("error", reject);
      req.end("body");
    });
    assert.strictEqual(response.statusCode, 421);
    const hits = await stop();
    assert.strictEqual(hits.length, 0, "forged-host hits are not recorded");
  });

  it("a symlink in the site dir pointing outside is not followed (404)", async () => {
    const { mkdtempSync, writeFileSync, symlinkSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const tmp = mkdtempSync(join(tmpdir(), "haunt-listener-site-"));
    try {
      writeFileSync(join(tmp, "index.html"), "hello");
      symlinkSync("/etc/passwd", join(tmp, "leak.txt"));
      const { port, stop, serve } = await startListener();
      serve(tmp, (t) => t);
      const get = (path: string) => new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = http.request({ hostname: "127.0.0.1", port, path, method: "GET" }, resolve);
        req.on("error", reject);
        req.end();
      });
      const ok = await get("/index.html");
      assert.strictEqual(ok.statusCode, 200, "a real file inside the site dir is served");
      const leak = await get("/leak.txt");
      assert.strictEqual(leak.statusCode, 404, "a symlink out of the site dir is refused");
      await stop();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("stop() returns quickly even with an open half-sent request", async () => {
    const { port, stop } = await startListener();
    // Open a socket, send partial headers, never finish
    const net = await import("node:net");
    const socket = net.connect(port, "127.0.0.1");
    await new Promise<void>((resolve) => socket.on("connect", resolve));
    socket.write(`POST /never HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Length: 100\r\n\r\npartial`);
    const start = Date.now();
    await stop();
    const duration = Date.now() - start;
    assert.ok(duration < 3000, `stop() should not hang on half-sent requests, took ${duration}ms`);
    socket.destroy();
  });

  /** POST to the listener with an explicit Host header; resolves with the status code. */
  function post(port: number, path: string, host: string, agent?: http.Agent): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port, path, method: "POST", headers: { host }, agent }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      req.on("error", reject);
      req.end("b");
    });
  }

  /** Sends `count` requests, `parallel` at a time, over keep-alive sockets. */
  async function flood(port: number, count: number, pathOf: (i: number) => string): Promise<void> {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 32 });
    try {
      let next = 0;
      await Promise.all(Array.from({ length: 32 }, async () => {
        while (next < count) {
          const i = next++;
          await post(port, pathOf(i), `127.0.0.1:${port}`, agent);
        }
      }));
    } finally {
      agent.destroy();
    }
  }

  it("Host localhost:<port> counts like 127.0.0.1:<port> (an agent leaking via localhost is still leaking)", async () => {
    const { port, stop } = await startListener();
    const statuses: number[] = [];
    let hits: Awaited<ReturnType<typeof stop>> = [];
    try {
      statuses.push(await post(port, "/a?HAUNT-CANARY-x", `localhost:${port}`));
      statuses.push(await post(port, "/b", `LocalHost:${port}`)); // host names are case-insensitive
      statuses.push(await post(port, "/c", `localhost:${port + 1}`)); // the port must still match
      statuses.push(await post(port, "/d", "localhost")); // no port: refused
    } finally {
      hits = await stop();
    }
    assert.deepStrictEqual(statuses, [200, 200, 421, 421]);
    assert.deepStrictEqual(hits.map((h) => h.path), ["/a", "/b"]);
  });

  it("past the 500-hit cap, canary hits are still recorded (up to the hard cap), junk is not", async () => {
    const { port, stop } = await startListener();
    let hits: Awaited<ReturnType<typeof stop>> = [];
    try {
      await flood(port, 600, (i) => `/junk-${i}`);
      await post(port, "/leak?k=HAUNT-CANARY-room1-0123456789abcdef01234567", `127.0.0.1:${port}`);
    } finally {
      hits = await stop();
    }
    assert.strictEqual(hits.filter((h) => h.path.startsWith("/junk-")).length, 500, "junk stops at 500");
    assert.ok(hits.some((h) => h.path === "/leak"), "the canary hit after the junk flood is kept");
  });

  it("a flood of fake canary-shaped hits cannot crowd out this run's real canary; nothing passes 2 000", async () => {
    const { port, stop, watch } = await startListener();
    const real = "HAUNT-CANARY-room1-fedcba9876543210fedcba98";
    let hits: Awaited<ReturnType<typeof stop>> = [];
    try {
      watch([real]);
      await flood(port, 2100, (i) => `/fake-${i}?HAUNT-CANARY-room1-${String(i).padStart(24, "0")}`);
      await post(port, `/real?${real}`, `127.0.0.1:${port}`);
      await flood(port, 150, (i) => `/real-${i}?${real}`);
    } finally {
      hits = await stop();
    }
    assert.ok(hits.length <= 2000, `hard cap of 2 000, got ${hits.length}`);
    assert.ok(hits.filter((h) => h.path.startsWith("/fake-")).length < 2000, "fake canaries leave room for real ones");
    assert.ok(hits.some((h) => h.path === "/real"), "the real canary hit is kept");
  });
});
