import { describe, it } from "node:test";
import assert from "node:assert";
import fc from "fast-check";
import { redact } from "../src/redact.js";
import * as os from "node:os";

describe("redact.ts", () => {
  describe("redact", () => {
    it("canary tokens survive redaction unchanged", () => {
      const token = "HAUNT-CANARY-room1-0123456789abcdef";
      const input = `Secret: ${token} is safe`;
      const output = redact(input);
      assert.ok(output.includes(token), "token should still be in output");
      assert.strictEqual(output, input);
    });

    it("AWS access key IDs are redacted", () => {
      const input = "AKIAIOSFODNN7EXAMPLE";
      const output = redact(input);
      assert.strictEqual(output, "[REDACTED]");
    });

    it("AWS secret access keys (40-char base64) are redacted", () => {
      // A 40-character base64 string (simulating AWS secret key)
      const input = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
      const output = redact(input);
      // The key should be redacted (may also redact adjacent content due to heuristic)
      assert.ok(output.includes("[REDACTED]"), "secret key should be redacted");
    });

    it("GitHub ghp_ tokens are redacted", () => {
      const token = "ghp_" + "a".repeat(36);
      const input = `Token: ${token}`;
      const output = redact(input);
      assert.ok(!output.includes(token), "token should be redacted");
      assert.ok(output.includes("[REDACTED]"));
    });

    it("GitHub github_pat_ tokens are redacted", () => {
      const token = "github_pat_" + "a".repeat(82);
      const input = `Token: ${token}`;
      const output = redact(input);
      assert.ok(!output.includes(token), "token should be redacted");
      assert.ok(output.includes("[REDACTED]"));
    });

    it("OpenAI sk- API keys are redacted", () => {
      const key = "sk-" + "a".repeat(32);
      const input = `Key: ${key}`;
      const output = redact(input);
      assert.ok(!output.includes(key), "key should be redacted");
      assert.ok(output.includes("[REDACTED]"));
    });

    it("PEM private key blocks are redacted", () => {
      const pem = `-----BEGIN RSA PRIVATE KEY-----
MIIEpQIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy
-----END RSA PRIVATE KEY-----`;
      const output = redact(pem);
      assert.ok(!output.includes("BEGIN RSA PRIVATE KEY"), "PEM should be redacted");
      assert.ok(output.includes("[REDACTED]"));
    });

    it("absolute paths under user's home are redacted", () => {
      const homeDir = os.homedir();
      const input = `User file: ${homeDir}/.config/myapp/config.json`;
      const output = redact(input);
      
      assert.ok(!output.includes(homeDir), "home path should be redacted");
      // Check that the redaction contains [REDACTED] and the filename
      assert.ok(output.includes("[REDACTED]"), "should contain redaction placeholder");
      assert.ok(output.includes("config.json"), "should preserve filename");
    });

    it("redact applied twice gives same result as once", () => {
      const input = "AKIAIOSFODNN7EXAMPLE and some text";
      const once = redact(input);
      const twice = redact(once);
      assert.strictEqual(once, twice);
    });

    it("string with no credentials or home paths is returned unchanged", () => {
      const input = "Just a normal string with no secrets";
      const output = redact(input);
      assert.strictEqual(output, input);
    });

    it("property test: canary tokens always preserved in random strings", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 10, maxLength: 100 }),
          (text) => {
            // Insert a canary token somewhere in the text
            const token = "HAUNT-CANARY-testroom-" + "a".repeat(20);
            const input = text.substring(0, 20) + token + text.substring(20);
            const output = redact(input);
            
            assert.ok(output.includes(token), "canary token should be preserved");
          }
        ),
        { numRuns: 50 }
      );
    });

    it("property test: credential patterns are always removed", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 10, maxLength: 100 }),
          (text) => {
            // Generate a fake AWS access key
            const fakeKey = "AKIA" + "A".repeat(16);
            const input = text.substring(0, 10) + fakeKey + text.substring(10);
            const output = redact(input);
            
            assert.ok(!output.includes(fakeKey), "AWS key should be redacted");
            assert.ok(output.includes("[REDACTED]"));
          }
        ),
        { numRuns: 50 }
      );
    });
  });
});
import { describe as describe2, it as it2 } from "node:test";
import assert2 from "node:assert/strict";
import { redact as redact2 } from "../src/redact.ts";

describe2("redact: review fixes", () => {
  it2("keeps every occurrence of a repeated canary", () => {
    const t = "HAUNT-CANARY-hall-0123456789abcdef0123";
    assert2.equal(redact2(`${t} and again ${t}`), `${t} and again ${t}`);
  });
  it2("keeps git object ids", () => {
    const sha = "e269c16f0a3b4c5d6e7f8091a2b3c4d5e6f70812";
    assert2.equal(redact2(`commit ${sha}`), `commit ${sha}`);
  });
  it2("removes Anthropic and Kiro keys", () => {
    const out = redact2("sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv_wx ksk_abcdefghijklmnop1234");
    assert2.ok(!out.includes("sk-ant-api03"));
    assert2.ok(!out.includes("ksk_abcdefghijklmnop"));
  });
});
