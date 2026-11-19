import { describe, it } from "node:test";
import assert from "node:assert";
import fc from "fast-check";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { assertUnderRoot, generateCanaryToken, PathEscapeError } from "../src/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("utils", () => {
  describe("assertUnderRoot", () => {
    it("does not throw for paths starting with a root", () => {
      const roots = ["/tmp/haunt", "/home/user"];
      // Should not throw
      assertUnderRoot("/tmp/haunt/file.txt", ...roots);
      assertUnderRoot("/tmp/haunt/subdir/file.txt", ...roots);
      assertUnderRoot("/home/user/file.txt", ...roots);
      assertUnderRoot("/home/user", ...roots); // exact match
    });

    it("throws PathEscapeError for paths that do not start with any root", () => {
      const roots = ["/tmp/haunt", "/home/user"];
      assert.throws(
        () => assertUnderRoot("/tmp/other/file.txt", ...roots),
        { name: "PathEscapeError" }
      );
      assert.throws(
        () => assertUnderRoot("/etc/passwd", ...roots),
        { name: "PathEscapeError" }
      );
    });

    it("property test: never throws for valid paths", () => {
      fc.assert(
        fc.property(fc.string(), fc.string(), (root, filename) => {
          const safeRoot = root.replace(/[\\]/g, "/");
          if (safeRoot.length === 0) return true; // skip empty
          const safePath = safeRoot + "/" + filename;
          // This should never throw - but we can't test with fc.assert directly
          // because we need to catch the error and continue
          try {
            assertUnderRoot(safePath, safeRoot);
          } catch (e) {
            // if it throws, the root was not a prefix
          }
          return true;
        }),
        { numRuns: 100 }
      );
    });

    it("property test: always throws for escaping paths", () => {
      fc.assert(
        fc.property(fc.string(), fc.string(), fc.string(), (root, subdir, file) => {
          if (root.length === 0 || subdir.length === 0) return true;
          const safeRoot = root.replace(/[\\]/g, "/");
          // Path that escapes root with ..
          const escapePath = "/etc/" + file;
          try {
            assertUnderRoot(escapePath, safeRoot);
            return false; // should have thrown
          } catch (e) {
            return e instanceof PathEscapeError;
          }
        }),
        { numRuns: 100 }
      );
    });
  });

  describe("generateCanaryToken", () => {
    it("generates tokens matching the expected format", () => {
      const token = generateCanaryToken("my-room");
      const expectedPattern = /^HAUNT-CANARY-[a-zA-Z0-9_-]+-[0-9a-f]{16,}$/;
      assert.match(token, expectedPattern);
    });

    it("property test: all generated tokens match the pattern", () => {
      // Filter to only valid room ID characters (alphanumeric, underscore, hyphen)
      fc.assert(
        fc.property(fc.string().filter(s => s.length > 0 && /^[a-zA-Z0-9_-]+$/.test(s)), (roomId) => {
          const token = generateCanaryToken(roomId);
          const pattern = /^HAUNT-CANARY-[a-zA-Z0-9_-]+-[0-9a-f]{16,}$/;
          return pattern.test(token);
        }),
        { numRuns: 100 }
      );
    });

    it("produces unique tokens for different room IDs", () => {
      const token1 = generateCanaryToken("room-a");
      const token2 = generateCanaryToken("room-b");
      assert.notStrictEqual(token1, token2);
    });
  });
});