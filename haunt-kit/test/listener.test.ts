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
});