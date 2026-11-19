import { describe, it } from "node:test";
import assert from "node:assert";
import fc from "fast-check";
import { redact, collectHostSecrets } from "../src/redact.js";
import * as os from "node:os";

// A canary in the real format generateCanaryToken produces (24 lowercase hex chars)
const CANARY = "HAUNT-CANARY-room1-0123456789abcdef01234567";

describe("redact.ts", () => {
  describe("redact", () => {
    it("canary tokens survive redaction unchanged", () => {
      const input = `Secret: ${CANARY} is safe`;
      const output = redact(input);
      assert.ok(output.includes(CANARY), "token should still be in output");
      assert.strictEqual(output, input);
    });

    it("only the exact canary format is preserved; lookalikes get no shield", () => {
      const short = "HAUNT-CANARY-room1-0123456789abcdef"; // 16 hex, not 24
      const long = "HAUNT-CANARY-room1-0123456789abcdef0123456789"; // 40 hex
      // A lookalike must not shield an embedded secret from the patterns
      const withSecret = `${short} ghp_${"a".repeat(36)}`;
      const out = redact(withSecret);
      assert.ok(!out.includes("ghp_"), "the secret next to a fake canary must be redacted");
      assert.ok(out.includes(short), "the lookalike itself matches no secret pattern and stays");
      assert.ok(!redact(`${long} ghp_${"a".repeat(36)}`).includes("ghp_"));
    });

    it("canaries passed via opts.canaries survive even in non-standard shapes", () => {
      const odd = "HAUNT-CANARY-x-zz";
      const out = redact(`password=${odd}`, { canaries: [odd] });
      assert.ok(out.includes(odd), "an explicitly listed canary is never redacted");
    });

    it("AWS access key IDs are redacted (AKIA and ASIA)", () => {
      assert.strictEqual(redact("AKIAIOSFODNN7EXAMPLE"), "[REDACTED]");
      assert.strictEqual(redact("ASIAIOSFODNN7EXAMPLE"), "[REDACTED]");
    });

    it("AWS secret access keys (40-char base64) are redacted", () => {
      const input = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
      const output = redact(input);
      assert.ok(output.includes("[REDACTED]"), "secret key should be redacted");
      assert.ok(!output.includes(input));
    });

    it("two adjacent 40-char AWS secrets are both redacted", () => {
      const s1 = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
      const s2 = "A1B2C3D4E5F6G7H8I9K0L1M2N3O4P5Q6R7S8T9U0";
      const out = redact(`${s1} ${s2}`);
      assert.ok(!out.includes(s1) && !out.includes(s2), `both secrets must go, got: ${out}`);
    });

    it("GitHub tokens of all prefixes are redacted", () => {
      for (const prefix of ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"]) {
        const token = prefix + "a".repeat(36);
        const output = redact(`Token: ${token}`);
        assert.ok(!output.includes(token), `${prefix} token should be redacted`);
      }
    });

    it("GitHub github_pat_ tokens are redacted", () => {
      const token = "github_pat_" + "a".repeat(82);
      const output = redact(`Token: ${token}`);
      assert.ok(!output.includes(token), "token should be redacted");
      assert.ok(output.includes("[REDACTED]"));
    });

    it("Slack, Stripe, Google, HuggingFace, npm, JWT and Kiro tokens are redacted", () => {
      const tokens = [
        "xoxb-" + "1".repeat(12),
        "xoxp-" + "ab".repeat(12),
        "sk_live_" + "4eC39HqLyjWDarjtb1aZ",
        "rk_test_" + "4eC39HqLyjWDarjtb1aZ",
        "AIza" + "SyD4yE7cRj".repeat(3) + "12345",
        "hf_" + "a".repeat(30),
        "npm_" + "a".repeat(36),
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSQKKV1a2b3c4",
        "ksk_abcdefghijklmnop1234",
      ];
      for (const token of tokens) {
        assert.ok(!redact(`t=${token}`).includes(token), `${token.slice(0, 12)}… should be redacted`);
      }
    });

    it("OpenAI/Anthropic sk- keys are redacted", () => {
      for (const key of ["sk-" + "a".repeat(20), "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv_wx"]) {
        const output = redact(`Key: ${key}`);
        assert.ok(!output.includes(key), "key should be redacted");
      }
    });

    it("assignment values are redacted, key names, separator and quoting kept", () => {
      assert.strictEqual(redact("password=hunter2x"), "password=[REDACTED]");
      assert.strictEqual(redact("api_key: abcdef123"), "api_key: [REDACTED]");
      assert.strictEqual(redact('DB_PASSWORD="s3cr3t99"'), 'DB_PASSWORD="[REDACTED]"');
    });

    it("assignments never redact a preserved canary", () => {
      const out = redact(`token=${CANARY}`);
      assert.ok(out.includes(CANARY));
    });

    it("URL credentials are redacted, host kept", () => {
      assert.strictEqual(redact("https://user:hunter2@example.com/x"), "https://[REDACTED]@example.com/x");
    });

    it("PEM private key blocks are redacted", () => {
      const pem = `-----BEGIN RSA PRIVATE KEY-----
MIIEpQIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy
-----END RSA PRIVATE KEY-----`;
      const output = redact(pem);
      assert.ok(!output.includes("BEGIN RSA PRIVATE KEY"), "PEM should be redacted");
      assert.ok(output.includes("[REDACTED]"));
    });

    it("a truncated PEM block (no END line) is redacted to the end of the text", () => {
      const pem = `-----BEGIN PRIVATE KEY-----\nMIIEvwIBADANBgkqhkiG9w0BAQEFAASC`;
      const output = redact(pem);
      assert.ok(!output.includes("BEGIN"), "truncated PEM should be redacted");
      assert.ok(!output.includes("MIIEvwIBADANBgkqhkiG9w0BAQEFAASC"));
    });

    it("percent-encoded secrets are decoded and redacted", () => {
      const secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
      const encoded = encodeURIComponent(`key=${secret}`);
      const out = redact(encoded);
      assert.ok(!out.includes(secret), `percent-encoded secret must not survive: ${out}`);
      assert.ok(!out.includes("%2F"), "published value is the decoded form");
    });

    it("base64-encoded secrets are redacted as a whole run", () => {
      const secret = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv_wx";
      const blob = Buffer.from(`the key is ${secret} ok`).toString("base64");
      const out = redact(`blob: ${blob}`);
      assert.ok(!out.includes(blob), "base64 blob hiding a secret must be replaced");
      assert.ok(out.includes("[REDACTED]"));
    });

    it("a base64 blob containing only a canary is left alone", () => {
      const blob = Buffer.from(`note ${CANARY} padding padding padding`).toString("base64");
      assert.strictEqual(redact(`x ${blob} y`), `x ${blob} y`);
    });

    it("absolute paths under user's home become ~", () => {
      const homeDir = os.homedir();
      const output = redact(`User file: ${homeDir}/.config/myapp/config.json`);
      assert.ok(!output.includes(homeDir), "home path should be redacted");
      assert.ok(output.includes("~/.config/myapp/config.json"), "should keep the subpath under ~");
    });

    it("/Users/<name> and /home/<name> prefixes become ~, also at end of string", () => {
      assert.strictEqual(redact("in /Users/someone/project now"), "in ~/project now");
      assert.strictEqual(redact("at /home/someone"), "at ~");
      assert.strictEqual(redact('quoted "/Users/x y"'), 'quoted "~ y"');
    });

    it("username, hostname and temp dirs are replaced", () => {
      const user = os.userInfo().username;
      const host = os.hostname();
      const tmp = os.tmpdir().replace(/\/+$/, "");
      const out = redact(`user ${user} on ${host} wrote ${tmp}/haunt-run-1/work`);
      if (user.length >= 3) assert.ok(!out.includes(user) && out.includes("[USER]"), "username → [USER]");
      if (host.length >= 3) assert.ok(!out.includes(host) && out.includes("[HOST]"), "hostname → [HOST]");
      assert.ok(!out.includes(tmp), "tmpdir should be replaced");
      assert.ok(out.includes("[TMP]/haunt-run-1/work"), `tmp form, got: ${out}`);
    });

    it("opts.secrets exact values are redacted", () => {
      const out = redact("leaked: my-super-token-value-123 here", { secrets: ["my-super-token-value-123"] });
      assert.ok(!out.includes("my-super-token-value-123"));
      // exactly 8 chars: replaced; shorter: ignored
      assert.strictEqual(redact("abc12345", { secrets: ["abc12345"] }), "[REDACTED]");
      assert.strictEqual(redact("abc1234", { secrets: ["abc1234"] }), "abc1234");
    });

    it("collectHostSecrets picks credential-named vars and token-looking values", () => {
      const secrets = collectHostSecrets({
        GH_TOKEN: "ghp_abc123",
        MY_PASSWORD: "hunter2x",
        RANDOM: "a1b2c3d4e5f6a1b2c3d4e5f6",
        PATH_LIKE: "/usr/bin:/bin:/opt/homebrew/bin",
        PLAIN: "hello",
      });
      assert.ok(secrets.includes("ghp_abc123") && secrets.includes("hunter2x"));
      assert.ok(secrets.includes("a1b2c3d4e5f6a1b2c3d4e5f6"), "long letter+digit value without /");
      assert.ok(!secrets.includes("/usr/bin:/bin:/opt/homebrew/bin"), "paths are not tokens");
      assert.ok(!secrets.includes("hello"));
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
          fc.string({ minLength: 10, maxLength: 100 }).map((s) => s.replaceAll("%", "").replaceAll("\u0000", "").replace(/[\uD800-\uDFFF]/g, "")),
          (text) => {
            const token = "HAUNT-CANARY-testroom-" + "a".repeat(24);
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
          fc.string({ minLength: 10, maxLength: 100 }).map((s) => s.replaceAll("%", "").replaceAll("\u0000", "").replace(/[\uD800-\uDFFF]/g, "")),
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

    it("property test: a secret of each format never survives - raw, percent-encoded or base64-encoded", () => {
      const secrets = [
        "ghp_" + "aB3".repeat(12),
        "gho_" + "Z9y".repeat(12),
        "xoxb-" + "1234567890ab",
        "sk_live_" + "4eC39HqLyjWDarjtb1aZ",
        "AIza" + "SyD4yE7cRj".repeat(3) + "12345",
        "hf_" + "ab12".repeat(8),
        "npm_" + "cd34".repeat(9),
        "AKIA" + "IOSFODNN7EXAMPLE",
        "sk-ant-api03-" + "AbCdEf".repeat(4),
        "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      ];
      fc.assert(
        fc.property(
          fc.string({ minLength: 0, maxLength: 40 }).map((s) => s.replaceAll("%", "").replaceAll("\u0000", "").replace(/[\uD800-\uDFFF]/g, "")),
          fc.nat({ max: secrets.length - 1 }),
          fc.constantFrom("raw", "percent", "base64"),
          (text, pick, mode) => {
            const secret = secrets[pick];
            let embedded = secret;
            if (mode === "percent") embedded = encodeURIComponent(secret);
            if (mode === "base64") embedded = Buffer.from(`k ${secret} v`).toString("base64");
            const input = `${text} ${embedded} ${text}`;
            const out = redact(input);
            assert.ok(!out.includes(secret), `${mode}: ${secret.slice(0, 12)}… survived in ${JSON.stringify(out)}`);
            if (mode === "percent") assert.ok(!out.includes(embedded), "still percent-encoded");
            if (mode === "base64") assert.ok(!out.includes(embedded), "base64 blob survived");
            // Idempotence on everything we publish
            assert.strictEqual(redact(out), out, "not idempotent");
          }
        ),
        { numRuns: 200 }
      );
    });
  });
});
import { describe as describe2, it as it2 } from "node:test";
import assert2 from "node:assert/strict";
import { redact as redact2 } from "../src/redact.ts";

describe2("redact: review fixes", () => {
  it2("keeps every occurrence of a repeated canary", () => {
    const t = "HAUNT-CANARY-hall-0123456789abcdef01234567";
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

describe2("redact: percent decoding that cannot be stopped", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAtestkeymaterialonly\n-----END RSA PRIVATE KEY-----";
  const enc = (t: string) => encodeURIComponent(t);
  it2("redacts a key encoded three times", () => {
    const out = redact2(enc(enc(enc(pem))));
    assert2.ok(!out.includes("MIIEowIBAAKCAQEA"), out);
  });
  it2("a malformed escape before the encoded key does not stop decoding", () => {
    for (const prefix of ["100%ZZ ", "%E2 ", "%"]) {
      const out = redact2(prefix + enc(pem));
      assert2.ok(!out.includes("MIIEowIBAAKCAQEA"), `${prefix}: ${out}`);
    }
  });
});

describe2("redact: second hardening pass", () => {
  const C = "HAUNT-CANARY-room1-0123456789abcdef01234567";
  const GHP = "ghp_" + "aB3".repeat(12);
  const r = (s: string) => {
    const once = redact2(s, { canaries: [C] });
    assert2.equal(redact2(once, { canaries: [C] }), once, `not idempotent: ${JSON.stringify(once)}`);
    return once;
  };

  it2("control and format characters are stripped before any rule", () => {
    assert2.equal(r("password=\u0000hunter2xyz"), "password=[REDACTED]");
    assert2.equal(r("password=hunter2\u0000xyz"), "password=[REDACTED]");
    assert2.equal(r("https://user:\u0000hunter22@host.com/x"), "https://[REDACTED]@host.com/x");
    assert2.equal(r(`pass​word=hunter22`), "password=[REDACTED]");
    assert2.equal(r(`x ${GHP.slice(0, 6)}​${GHP.slice(6)} y`), "x [REDACTED] y", "zero-width char inside a token");
    assert2.equal(r(`%E2%80%8B${GHP}`), "[REDACTED]", "percent-encoded zero-width char");
    assert2.equal(r("\u001b[31mtoken=abc123def\u001b[0m done"), "token=[REDACTED] done", "ANSI escapes go whole");
    assert2.equal(r("tab\tnew\nline\r\n"), "tab\tnew\nline\r\n", "tab/LF/CR stay");
  });

  it2("a NUL-wrapped index in the input cannot forge a canary placeholder", () => {
    const out = redact2("x \u00000\u0000 y", { canaries: [C] });
    assert2.equal(out, "x 0 y");
    assert2.ok(!out.includes(C));
  });

  it2("base64 runs are checked with the identity rules too", () => {
    const b64 = (s: string) => Buffer.from(s).toString("base64");
    for (const plain of [
      `${os.homedir()}/.ssh/id_rsa`,
      "/Users/someone/Documents/notes.txt",
      `user ${os.userInfo().username} wrote this`,
      `host ${os.hostname()} said hi`,
      `${os.tmpdir().replace(/\/+$/, "")}/haunt-run-1/work`,
    ]) {
      const out = r(`blob ${b64(plain)} end`);
      assert2.equal(out, "blob [REDACTED] end", `${plain} survived base64: ${out}`);
    }
  });

  it2("base64 hiding a secret behind binary bytes, a key= prefix, or nested base64 is caught", () => {
    const withBinary = Buffer.concat([Buffer.from([0xff, 0x00, 0xfe]), Buffer.from(GHP), Buffer.from([0x01, 0x80, 0x90, 0xaa])]);
    assert2.equal(r(`x ${withBinary.toString("base64")}`), "x [REDACTED]");
    assert2.equal(r(`data=${Buffer.from(`key ${GHP}`).toString("base64")}`), "data=[REDACTED]");
    const nested = Buffer.from(Buffer.from(`the key ${GHP} ok`).toString("base64")).toString("base64");
    assert2.equal(r(`n ${nested}`), "n [REDACTED]");
  });

  it2("email addresses become [EMAIL]; fixture domains, versions, file names and git remotes stay", () => {
    assert2.equal(r("mail jane.doe@gmail.com now"), "mail [EMAIL] now");
    assert2.equal(r("Co-Authored-By: Someone <some.one+tag@corp.co.kr>"), "Co-Authored-By: Someone <[EMAIL]>");
    for (const kept of [
      "ledger@prod-db.internal", "agent@haunt.invalid", "pi@raspberry.local", "a@b.example",
      "test@example.com", "x@mail.example.com", "123+bot@users.noreply.github.com",
      "typescript@5.7.0", "icon@2x.png", "git@github.com:org/repo.git", "haunt-kit@localhost",
    ]) {
      assert2.equal(r(`see ${kept} here`), `see ${kept} here`, kept);
    }
    assert2.equal(r("postgres://ledger@prod-db.internal:5432/db"), "postgres://ledger@prod-db.internal:5432/db");
  });

  it2("Google AIza keys are caught in every context", () => {
    const key = "AIza" + "SyD4yE7cRj".repeat(3) + "12345"; // AIza + 35
    assert2.equal(key.length, 39);
    for (const ctx of [key, `GOOGLE_MAPS=${key}`, `{"maps": "${key}"}`, `?key=${key}&x=1`, `url(${key})`]) {
      assert2.ok(!r(ctx).includes(key), ctx);
    }
  });

  it2("bare 32–64 hex values assigned to a key are caught; git object ids stay", () => {
    const hex64 = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    const hex32 = hex64.slice(0, 32);
    const sha = hex64.slice(0, 40);
    assert2.equal(r(`SOMETHING=${hex64}`), "SOMETHING=[REDACTED]");
    assert2.equal(r(`WEBHOOK_SIG=${hex32.toUpperCase()}`), "WEBHOOK_SIG=[REDACTED]");
    assert2.equal(r(`{"x": "${hex64}"}`), `{"x": "[REDACTED]"}`);
    assert2.equal(r(`cfg.signing: '${hex32}'`), `cfg.signing: '[REDACTED]'`);
    assert2.equal(r(`commit ${sha}`), `commit ${sha}`);
    assert2.equal(r(`{"commit": "${sha}", "baseCommit": "${sha}"}`), `{"commit": "${sha}", "baseCommit": "${sha}"}`);
    assert2.equal(r(`HEAD=${sha}`), `HEAD=${sha}`);
    assert2.equal(r(`index 83db48f..bf269f4 100644`), `index 83db48f..bf269f4 100644`);
  });

  it2("assignments: prose and code stay, separator and quoting are kept", () => {
    for (const prose of [
      "auth: required before pushing", "session: Completed123", "OAuth: authenticate",
      "password: required", "Token: none", "tokens: 12,345", "author: someone123456",
      "const token = process.env.GITHUB_TOKEN;", "token: string", "STRIPE_TEST_KEY=not-a-real-key",
      "token_url: https://auth.example.com/oauth/token2", "Bearer authentication is required",
    ]) {
      assert2.equal(r(prose), prose, prose);
    }
    assert2.equal(r("password: hunter2x"), "password: [REDACTED]");
    assert2.equal(r("password = hunter2x"), "password = [REDACTED]");
    assert2.equal(r("token := abc123xyz"), "token := [REDACTED]");
    assert2.equal(r("dbPassword: 'hunter2x'"), "dbPassword: '[REDACTED]'");
    assert2.equal(r(`{"password": "hunter 2 x"}`), `{"password": "[REDACTED]"}`);
    assert2.equal(r(`{\\"token\\": \\"abc123xyz\\"}`), `{\\"token\\": \\"[REDACTED]\\"}`, "escaped JSON");
    assert2.equal(r("GH_TOKEN=abcdefghijklmnopqrstu"), "GH_TOKEN=[REDACTED]", "≥16 chars without a digit");
    assert2.equal(r("PAYMENTS_LIVE_KEY=pk9xyz123"), "PAYMENTS_LIVE_KEY=[REDACTED]");
    assert2.equal(r("session=abc123def456ghi789"), "session=[REDACTED]", "a weak key still loses a token-shaped value");
  });

  it2("assignments and URLs never touch a preserved canary", () => {
    assert2.equal(r(`token=${C}`), `token=${C}`);
    assert2.equal(r(`"password": "${C}"`), `"password": "${C}"`);
    assert2.equal(r(`token=${C}/hunter22xyz`), `token=${C}[REDACTED]`, "the rest of the value still goes");
    assert2.equal(r(`postgres://ledger:${C}@prod-db.internal/x`), `postgres://ledger:${C}@prod-db.internal/x`);
    const pem = `-----BEGIN OPENSSH PRIVATE KEY-----\n${C}\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----`;
    assert2.equal(r(pem), `[REDACTED] ${C}`);
  });

  it2("URL passwords containing '@' and auth headers are redacted", () => {
    assert2.equal(r("postgres://admin:P@ssw0rd@db.corp/x"), "postgres://[REDACTED]@db.corp/x");
    assert2.equal(r("Authorization: Basic dXNlcjpwYXNz"), "Authorization: Basic [REDACTED]");
    assert2.equal(r("Authorization: Bearer abc.def.ghi123"), "Authorization: Bearer [REDACTED]");
  });

  it2("patches: '+' lines and commit ids are not corrupted", () => {
    const b64 = Buffer.from(`the key is ${GHP} ok`).toString("base64");
    const patch = [
      "diff --git a/x b/x",
      "index 83db48f..bf269f4 100644",
      "@@ -1,2 +1,3 @@",
      `+${b64}`,
      "+password=hunter2x",
      "+ok line here",
      `-${b64}`,
    ].join("\n");
    assert2.equal(r(patch), [
      "diff --git a/x b/x",
      "index 83db48f..bf269f4 100644",
      "@@ -1,2 +1,3 @@",
      "+[REDACTED]",
      "+password=[REDACTED]",
      "+ok line here",
      "-[REDACTED]",
    ].join("\n"));
  });

  it2("separator lines are not mistaken for 40-char secrets", () => {
    for (const line of ["=".repeat(60), "/".repeat(40), "+".repeat(48)]) assert2.equal(r(line), line);
  });
});

describe2("redact: form-encoded keys inside evidence lines", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAformencodedkeymaterial\n-----END RSA PRIVATE KEY-----";
  it2("a URLSearchParams body wrapped in an evidence line is redacted", () => {
    const body = new URLSearchParams({ k: pem }).toString();
    const out = redact2(`[POST] /x - body: ${body}`);
    assert2.ok(!out.includes("MIIEowIBAAKCAQEA"), out);
  });
  it2("a key encoded five times is redacted", () => {
    let t = pem;
    for (let i = 0; i < 5; i++) t = encodeURIComponent(t);
    assert2.ok(!redact2(t).includes("MIIEowIBAAKCAQEA"));
  });
  it2("a plain '+' in prose and in base64 is kept", () => {
    assert2.equal(redact2("1+1=2 and a+b"), "1+1=2 and a+b");
  });
});

describe2("redact: Google keys of near length", () => {
  it2("redacts AIza keys of 34 to 36 trailing characters", () => {
    for (const n of [34, 35, 36]) {
      const key = "AIza" + "Sy" + "A1b2C3d4".repeat(5).slice(0, n - 2);
      assert2.ok(!redact2(`MAPS=${key}`).includes(key.slice(6)), `${n}`);
    }
  });
});
