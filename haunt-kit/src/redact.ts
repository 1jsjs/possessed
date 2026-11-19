// Redaction - removes credentials, host identity and host paths from anything we publish.
// Pure and idempotent: redact(redact(x)) === redact(x).
//
// Pipeline: strip terminal escapes and control/format characters → percent-decode
// (≤4 rounds) → shield the real canaries with placeholders → exact host secrets, PEM
// blocks, URL credentials, fixed secret patterns, AWS-style secrets, auth headers,
// emails, assignments, hex assignments → base64 runs whose decoded form would be
// redacted by any of those OR by the identity rules → identity (home/user/host/tmp) →
// unshield canaries. The published value is the decoded, redacted form.
//
// Every pattern is written so that a failed match cannot restart inside the same run
// of characters (lookbehind anchors, bounded quantifiers, disjoint character classes):
// redact() is linear in its input. Agent output is capped at 2 MiB and export runs
// redact again, so one quadratic regex is minutes per run.

import { homedir, hostname, tmpdir, userInfo } from "node:os";
import { realpathSync } from "node:fs";
import { CANARY_TOKEN_SOURCE } from "./types.js";

export interface RedactOptions {
  /** exact canary strings that must survive redaction */
  canaries?: string[];
  /** additional exact secret values to remove (host env values etc.) */
  secrets?: string[];
}

const REDACTED = "[REDACTED]";
const EMAIL = "[EMAIL]";
const MARKER_RE = /\[(?:REDACTED|EMAIL)\]/g;

// The exact canary format, word-bounded: HAUNT-CANARY-<roomId>-<24 hex>.
// A shorter/longer or otherwise shaped lookalike is not a canary and gets no shield.
const CANARY_RE = new RegExp(`\\b(?:${CANARY_TOKEN_SOURCE})\\b`, "g");

// Placeholders wrap the index in NUL. Input never contains NUL (it is stripped first), so
// a placeholder cannot be forged, and no secret pattern, base64 run or email matches
// across one. Value rules that can span a placeholder keep it and judge only the rest.
const placeholder = (i: number) => `\u0000${i}\u0000`;
const PLACEHOLDER_SPLIT_RE = /(\u0000\d+\u0000)/;

// ─────────────────────────────────────────────────────────────────────────
// Control and format characters
// ─────────────────────────────────────────────────────────────────────────

// Terminal escape sequences go whole (CSI "ESC[…m", OSC "ESC]…BEL", two-char "ESC x"),
// so stripping ESC below leaves no "[31m" debris in a published transcript. The three
// CSI classes are disjoint and the OSC body stops at the next ESC: linear.
const ANSI_RE = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]{0,4096}(?:\u0007|\u001B\\)|[@-Z\\-_])/g;

// C0 controls other than tab/LF/CR, DEL, C1 controls and Unicode format characters
// (zero-width space/joiners, bidi overrides, BOM, soft hyphen, tag characters). A NUL
// inside a value used to skip the assignment and URL-credential rules
// ("password=\u0000hunter2…"), and a zero-width character inside a token hides it from
// every pattern while the site still shows it intact. Canary placeholders are created
// AFTER this strip, so they are never eaten by it.
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\p{Cf}]/gu;

function stripControls(text: string): string {
  return text.replace(ANSI_RE, "").replace(CONTROL_RE, "");
}

// ─────────────────────────────────────────────────────────────────────────
// Percent decoding
// ─────────────────────────────────────────────────────────────────────────

// Decodes each run of %XX escapes on its own, so one malformed escape ("100%ZZ", a lone
// "%E2") cannot stop the rest of the text from being decoded; repeats for multiply-encoded
// text. Invalid UTF-8 becomes U+FFFD instead of throwing.
const UTF8 = new TextDecoder("utf-8");
function decodeRuns(text: string): string {
  return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    const bytes = Uint8Array.from(run.match(/%([0-9A-Fa-f]{2})/g)!.map((h) => parseInt(h.slice(1), 16)));
    return UTF8.decode(bytes);
  });
}

function percentDecode(text: string): string {
  let cur = text;
  for (let round = 0; round < 10; round++) {
    if (!/%[0-9A-Fa-f]{2}/.test(cur)) break;
    // A form-encoded token (key=value&…, with %XX escapes) encodes spaces as '+'. This is
    // decided per whitespace-free token, because evidence lines wrap a form body in other
    // text ("[POST] /x - body: k=-----BEGIN+RSA+…"). Elsewhere '+' is kept, so base64 runs
    // with '+' survive for the base64 check. Linear: one pass over \S+ runs.
    const formed = cur.replace(/\S+/g, (tok) => (tok.includes("=") && /%[0-9A-Fa-f]{2}/.test(tok) ? tok.replace(/\+/g, " ") : tok));
    // A decoded %00 or %E2%80%8B is stripped like the raw character would have been.
    const next = stripControls(decodeRuns(formed));
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

// ─────────────────────────────────────────────────────────────────────────
// Secret patterns
// ─────────────────────────────────────────────────────────────────────────

// 40-char AWS-style secrets: lookarounds instead of consuming groups, so two
// adjacent secrets separated by one character are both caught. The boundary is
// "not a word char", matching the old consuming form (`=`/`/`/`+` still count as
// boundaries, so `aws_secret_access_key=wJalr…` is caught). Lowercase-hex 40-char
// strings are git object ids (evidence, not secrets) and stay. Fixed width: at most
// 40 steps per start.
const AWS_SECRET_RE = /(?<![A-Za-z0-9_])([A-Za-z0-9/+=]{40})(?![A-Za-z0-9_])/g;

// Each starts with a literal prefix and ends in a greedy or fixed run with nothing
// after it (or, for JWT/SendGrid, a delimiter the run's class excludes), so a failed
// attempt costs at most the run it is in.
const FIXED_PATTERNS: RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{36,}/g,                       // GitHub gho_/ghp_/ghu_/ghs_/ghr_
  /github_pat_[A-Za-z0-9_]{60,}/g,                     // GitHub fine-grained PAT
  /glpat-[A-Za-z0-9_-]{20,}/g,                         // GitLab PAT
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,                     // Slack
  /hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}/g, // Slack webhook
  /discord(?:app)?\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]{20,}/g, // Discord webhook
  /(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g,         // Stripe
  /AIza[0-9A-Za-z_-]{30,}/g,                           // Google API key ("AIza" + 35 chars; near-length variants too)
  /ya29\.[0-9A-Za-z_-]{20,}/g,                         // Google OAuth access token
  /GOCSPX-[A-Za-z0-9_-]{20,}/g,                        // Google OAuth client secret
  /hf_[A-Za-z0-9]{30,}/g,                              // Hugging Face
  /npm_[A-Za-z0-9]{36}/g,                              // npm
  /SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,       // SendGrid
  // JWT. The lookbehind anchors the match: on "eyJeyJeyJ…" a failed attempt must
  // not restart at the next "eyJ" inside the same run (quadratic backtracking).
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /(?:AKIA|ASIA)[0-9A-Z]{16}/g,                        // AWS access key id (long-lived + session)
  /sk-ant-[A-Za-z0-9_-]{16,}/g,                        // Anthropic
  /sk-[A-Za-z0-9_-]{20,}/g,                            // OpenAI-style (also OpenRouter, Moonshot)
  /ksk_[A-Za-z0-9_-]{16,}/g,                           // Kiro
];

// "Authorization: Bearer <token>" / "Basic <base64>": the scheme stays.
const AUTH_SCHEME_RE = /(?<![A-Za-z0-9])(Bearer|bearer|BEARER|Basic)([ \t]+)([A-Za-z0-9._~+/=-]{8,})/g;

// user:pass@host credentials inside URLs; scheme and host stay. The lookbehind (same
// class as the scheme) and the bounded parts keep a failed match from restarting at
// every character of a long word run (quadratic on 100k+ word chars without it). The
// password may contain '@' ("P@ssw0rd"): it runs to the last '@' before the host.
const URL_CRED_RE = /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/)([^/\s:@]{1,256}):([^\s/]{1,256})@/g;

// Email addresses become [EMAIL] - except placeholder/fixture domains, so lure
// addresses like ledger@prod-db.internal survive as evidence. The lookbehind is the
// local-part class itself, so an attempt only starts at the beginning of a run. The
// TLD must be letters: "pkg@1.2.3" is a version, not an address.
const EMAIL_RE = /(?<![A-Za-z0-9._%+-])([A-Za-z0-9._%+-]+)@((?:[A-Za-z0-9-]{1,63}\.){1,16}[A-Za-z]{2,63})(?![A-Za-z0-9-])/g;
const KEPT_EMAIL_DOMAIN_RE =
  /(?:^|\.)(?:invalid|internal|local|localhost|test|example|example\.com|example\.org|example\.net|users\.noreply\.github\.com)$/i;
// "icon@2x.png" is a file name.
const FILE_EXT_TLD_RE =
  /\.(?:png|jpe?g|gif|svg|webp|ico|bmp|avif|js|mjs|cjs|ts|tsx|jsx|json|css|scss|less|html?|txt|lock|ya?ml|toml|map|wasm|woff2?|ttf|otf|pdf)$/i;

// PEM private key, up to the END line or - for a truncated capture - the end of the text.
// One attempt per BEGIN line; an unterminated block consumes the rest, so attempts
// never overlap.
// '+' is accepted between header words too, for a form-encoded key whose '+' signs were
// not turned into spaces.
const PEM_RE = /-----BEGIN[ +][A-Z +]*PRIVATE[ +]KEY(?:[ +]BLOCK)?-----[\s\S]*?(?:-----END[ +][A-Z +]*PRIVATE[ +]KEY(?:[ +]BLOCK)?-----|$)/g;

// ── Assignments ──────────────────────────────────────────────────────────
//
// key=value / key: value / "key": "value" for credential-ish key names. The key, the
// original separator and the original quoting are kept; only the value is replaced.
//
// The key word must start an identifier or follow _ - . (DB_PASSWORD, x-api-key) or a
// camelCase hump (dbPassword, accessToken) - never the middle of a word: "OAuth: …"
// does not match the "auth" inside it. (?-i:…) keeps the hump test case-sensitive
// inside an otherwise case-insensitive pattern; RegExp() because TypeScript's regex
// literal checker does not know modifiers yet.
const KEY_WORDS = [
  "pass(?:word|wd|phrase)?", "pwd", "secret", "token", "api[_-]?key", "access[_-]?key",
  "private[_-]?key", "credentials?", "auth", "session", "cookie",
  "(?<=(?-i:[A-Z0-9])[_-])(?-i:KEY)", // env style: PAYMENTS_LIVE_KEY, SIGNING_KEY
].join("|");
const KEY_START = "(?:(?<![A-Za-z0-9])|(?<=(?-i:[a-z0-9]))(?=(?-i:[A-Z])))";
// An identifier tail after the key word: _file, .value, Hash (bounded, so a failed
// attempt backtracks at most 40 characters).
const KEY_TAIL = "(?:[_.-][A-Za-z0-9_.-]{0,40}|(?-i:[A-Z])[A-Za-z0-9_.-]{0,40})?";
// "=", ":", ":=", "=>", optionally after the key's closing quote, possibly escaped
// (\"password\": \"…\" inside a JSON string).
const ASSIGN_SEP = `(\\\\?["']?[ \\t]*(?::=|=>|[=:])[ \\t]*)`;
// Value: double-quoted, single-quoted (each possibly escaped; the closing quote is
// optional so an unterminated or very long string is still covered), or bare. Each
// body class excludes its own terminator, so nothing backtracks.
const ASSIGN_VALUE =
  `(?:(\\\\?")((?:[^"\\\\\\n]|\\\\[^"\\n])*)(\\\\?"|)` +
  `|(\\\\?')((?:[^'\\\\\\n]|\\\\[^'\\n])*)(\\\\?'|)` +
  `|([^\\s"',;]+))`;
const ASSIGNMENT_RE = new RegExp(`${KEY_START}((?:${KEY_WORDS})s?${KEY_TAIL})${ASSIGN_SEP}${ASSIGN_VALUE}`, "gi");

// Key components that make a key strong (any value with a digit or ≥16 chars goes);
// keys built only from auth/session/cookie are weak (prose-prone: "auth: required",
// "session: Completed123") and need a token-shaped value of ≥16 chars.
const STRONG_KEY_PARTS = new Set([
  "pass", "password", "passwd", "passphrase", "pwd", "secret", "secrets", "token", "tokens",
  "key", "keys", "apikey", "accesskey", "privatekey", "credential", "credentials",
]);
const PASSWORD_PARTS = new Set(["pass", "password", "passwd", "passphrase", "pwd", "secret", "secrets"]);
// A key whose last component names metadata about the credential, not the credential.
const METADATA_PARTS = new Set([
  "url", "uri", "file", "path", "dir", "name", "type", "kind", "expiry", "expires", "expiration",
  "ttl", "timeout", "length", "len", "size", "count", "endpoint", "header", "prefix", "suffix",
  "policy", "hint", "label", "format", "mode", "required", "enabled", "provider", "method",
  "scope", "scopes", "version", "location", "field", "env", "var",
]);

const keyParts = (key: string) =>
  key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter(Boolean).map((p) => p.toLowerCase());

// A plain word is never a credential: required, Completed, none. (16+ letters is
// redacted anyway: a long letters-only value is a passphrase more often than a word.)
const PLAIN_WORD_RE = /^[A-Za-z][a-z]{0,14}$/;
// Lowercase prose (weak keys only): "required before pushing".
const PROSE_RE = /^[A-Za-z][a-z']*(?:[ ,.;:!?-]+[A-Za-z][a-z']*)+[.!?]?$/;
// Counts: "tokens: 12,345".
const NUMBER_RE = /^[\d,._]+[kKmM]?$/;
// Code references are not values: process.env.TOKEN, ${TOKEN}, %TOKEN%, getToken(…).
const CODE_REF_RE =
  /^(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|%[A-Za-z_][A-Za-z0-9_]*%|(?:process\.env|import\.meta\.env|os\.environ|env|config|settings|options|opts|args|argv|params|props|req|res|request|response|this|self|ctx|context)(?:\.[A-Za-z_$][\w$]*|\[[^\]\n]*\])*[;,)]*|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(.*)$/;

function secretValue(raw: string, strong: boolean, passwordKey: boolean): boolean {
  const v = raw.replace(MARKER_RE, "").trim();
  if (!v || PLAIN_WORD_RE.test(v) || CODE_REF_RE.test(v)) return false;
  if (!passwordKey && NUMBER_RE.test(v)) return false;
  if (!strong) return v.length >= 16 && !PROSE_RE.test(v);
  return v.length >= 6 && (/\d/.test(v) || v.length >= 16);
}

/** Redacts a value, keeping any canary placeholder inside it and judging only the rest. */
function redactValue(value: string, decide: (s: string) => boolean): string {
  if (!value.includes("\u0000")) return decide(value) ? REDACTED : value;
  return value
    .split(PLACEHOLDER_SPLIT_RE)
    .map((seg, i) => (i % 2 === 1 || !seg || !decide(seg) ? seg : REDACTED))
    .join("");
}

function redactAssignment(
  m: string, key: string, sep: string,
  dqOpen?: string, dqBody?: string, dqClose?: string,
  sqOpen?: string, sqBody?: string, sqClose?: string,
  bare?: string,
): string {
  const parts = keyParts(key);
  if (parts.length > 1 && METADATA_PARTS.has(parts[parts.length - 1])) return m;
  const strong = parts.some((p) => STRONG_KEY_PARTS.has(p));
  const passwordKey = parts.some((p) => PASSWORD_PARTS.has(p));
  const decide = (s: string) => secretValue(s, strong, passwordKey);
  if (dqOpen !== undefined) return `${key}${sep}${dqOpen}${redactValue(dqBody ?? "", decide)}${dqClose ?? ""}`;
  if (sqOpen !== undefined) return `${key}${sep}${sqOpen}${redactValue(sqBody ?? "", decide)}${sqClose ?? ""}`;
  return `${key}${sep}${redactValue(bare ?? "", decide)}`;
}

// ── Hex assignments ──────────────────────────────────────────────────────
//
// A bare 32–256-char hex value assigned to any key (KEY=<hex> or "x": "<hex>"): API keys
// and webhook secrets are often plain hex. Not keyed on a credential name - hex this
// long is never prose. A git object id standing alone ("commit e269c16f…") has no = or :
// before it and stays; so does one assigned to a commit/sha/hash-like key. The
// lookbehind anchors the key at an identifier start and the key is bounded.
const HEX_ASSIGN_RE =
  /(?<![A-Za-z0-9_.-])(\\?["']?)([A-Za-z_][A-Za-z0-9_.-]{0,63})(\\?["']?[ \t]*(?::=|=>|[=:])[ \t]*\\?["']?(?:0x)?)([0-9a-fA-F]{32,256})(?![0-9A-Za-z_])/g;
const HEX_ID_KEY_PARTS = new Set([
  "commit", "sha", "sha1", "sha256", "sha512", "shasum", "sha1sum", "sha256sum", "sha512sum",
  "md5", "md5sum", "rev", "revision", "parent", "tree", "head", "base", "oid", "object", "hash",
  "digest", "checksum", "etag", "ref", "blob", "id", "uuid", "guid", "fingerprint", "integrity",
]);

function redactHexAssignment(m: string, q: string, key: string, sep: string): string {
  const parts = keyParts(key);
  if (parts.some((p) => HEX_ID_KEY_PARTS.has(p)) && !parts.some((p) => STRONG_KEY_PARTS.has(p))) return m;
  return `${q}${key}${sep}${REDACTED}`;
}

// ─────────────────────────────────────────────────────────────────────────
// Secret rules on placeholder-shielded text (no decode, no base64, no identity)
// ─────────────────────────────────────────────────────────────────────────

function redactSecretPatterns(text: string, extraSecrets: string[]): string {
  let out = text;

  // Exact host secrets first, longest first: a later rule that rewrites part of one
  // (an email inside it, say) would leave the rest unmatched.
  for (const secret of extraSecrets) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  // A canary inside a key block survives the block.
  out = out.replace(PEM_RE, (m) => [REDACTED, ...(m.match(/\u0000\d+\u0000/g) ?? [])].join(" "));
  out = out.replace(URL_CRED_RE, (m, scheme: string, user: string, pass: string) => {
    if (pass.includes("\u0000")) return m; // canary in the password slot (lure URLs)
    return user.includes("\u0000") ? `${scheme}${user}:${REDACTED}@` : `${scheme}${REDACTED}@`;
  });
  for (const re of FIXED_PATTERNS) {
    out = out.replace(re, REDACTED);
  }
  // A random 40-char secret has a letter and many distinct characters; a separator line
  // ("=====…", "/////…") does not.
  out = out.replace(AWS_SECRET_RE, (m, key: string) =>
    /^[0-9a-f]{40}$/.test(key) || !/[A-Za-z]/.test(key) || new Set(key).size < 8 ? m : REDACTED);
  // Any token-shaped credential after the scheme goes ("Basic dXNlcjpwYXNz" has no digit).
  out = out.replace(AUTH_SCHEME_RE, (m, scheme: string, space: string, token: string) =>
    PLAIN_WORD_RE.test(token) || CODE_REF_RE.test(token) ? m : `${scheme}${space}${REDACTED}`);
  out = out.replace(EMAIL_RE, (m, local: string, domain: string) =>
    KEPT_EMAIL_DOMAIN_RE.test(domain) || FILE_EXT_TLD_RE.test(`.${domain}`) || local.toLowerCase() === "git"
      ? m : EMAIL);
  out = out.replace(ASSIGNMENT_RE, redactAssignment);
  out = out.replace(HEX_ASSIGN_RE, redactHexAssignment);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Base64 runs
// ─────────────────────────────────────────────────────────────────────────

// Greedy with nothing after it: a run is matched once; a run shorter than 24 costs at
// most 24 steps per start.
const B64_RUN_RE = /[A-Za-z0-9+/=_-]{24,}/g;
const MAX_B64_DEPTH = 2; // base64 inside base64 inside base64

interface Ctx {
  canaries: string[];
  /** no explicit canary list: canary-format strings are shielded wherever found */
  formatMode: boolean;
  secrets: string[];
}

function shield(text: string, canaries: string[]): string {
  let out = text;
  canaries.forEach((c, i) => {
    if (out.includes(c)) out = out.split(c).join(placeholder(i));
  });
  return out;
}

/** True when the decoded form of a base64 string would be changed by any rule. */
function decodesToRedactable(b64: string, ctx: Ctx, depth: number): boolean {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(b64.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  } catch {
    return false;
  }
  if (bytes.length < 6) return false;
  // What a reader sees after decoding: control/format characters and invalid UTF-8
  // dropped. Dropping (not splitting on) them means a stray binary byte planted in
  // the middle of a token does not hide it. Binary blobs can match by chance and are
  // then redacted whole - noise, never a leak.
  let inner = stripControls(bytes.toString("utf-8")).replace(/�/g, "");
  if (inner.length < 6) return false;
  inner = percentDecode(inner);
  // Shield canaries inside the decoded text exactly like the outer pass does.
  let canaries = ctx.canaries;
  if (ctx.formatMode) {
    const found = [...inner.matchAll(CANARY_RE)].map((m) => m[0]).filter((c) => !canaries.includes(c));
    if (found.length) canaries = [...canaries, ...new Set(found)];
  }
  const shielded = shield(inner, canaries);
  let out = redactSecretPatterns(shielded, ctx.secrets);
  if (depth < MAX_B64_DEPTH) out = redactBase64Runs(out, { ...ctx, canaries }, depth + 1);
  out = redactIdentity(out);
  return out !== shielded;
}

/** Replace base64 runs whose decoded form would itself be redacted. */
function redactBase64Runs(text: string, ctx: Ctx, depth: number): string {
  return text.replace(B64_RUN_RE, (match: string, offset: number, whole: string) => {
    // "+…" / "-…" at the start of a line is a diff marker in a patch, not payload: keep it.
    let lead = "";
    let run = match;
    if ((run[0] === "+" || run[0] === "-") && (offset === 0 || whole[offset - 1] === "\n")) {
      lead = run[0];
      run = run.slice(1);
    }
    if (decodesToRedactable(run, ctx, depth) || (lead && decodesToRedactable(match, ctx, depth))) {
      return lead + REDACTED;
    }
    // Several base64 units glued by '=' ("token=<b64>", "<b64>==<b64>"): check each.
    if (/=[^=]/.test(run)) {
      const pieces = run.split(/(=+)/);
      let changed = false;
      for (let i = 0; i < pieces.length; i += 2) {
        if (pieces[i].length < 16 || !decodesToRedactable(pieces[i], ctx, depth)) continue;
        pieces[i] = REDACTED;
        // its own padding goes with it
        if (i + 1 < pieces.length && pieces[i + 1].length <= 2) pieces[i + 1] = "";
        changed = true;
      }
      if (changed) return lead + pieces.join("");
    }
    return match;
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Identity (home dir, username, hostname, temp paths)
// ─────────────────────────────────────────────────────────────────────────

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface Identity {
  home: string;
  user?: RegExp;
  hosts: RegExp[];
  tmps: string[];
}

// Looked up once: redact() runs on every string of every exported run.
let identityCache: Identity | undefined;
function identity(): Identity {
  if (identityCache) return identityCache;
  const id: Identity = { home: homedir(), hosts: [], tmps: [] };
  try {
    const user = userInfo().username;
    if (user && user.length >= 3) id.user = new RegExp(`\\b${escapeRegExp(user)}\\b`, "g");
  } catch { /* userInfo unavailable */ }
  try {
    const host = hostname();
    if (host && host.length >= 3) {
      id.hosts.push(new RegExp(`\\b${escapeRegExp(host)}\\b`, "g"));
      const first = host.split(".")[0];
      if (first && first !== host && first.length >= 3) id.hosts.push(new RegExp(`\\b${escapeRegExp(first)}\\b`, "g"));
    }
  } catch { /* hostname unavailable */ }
  const tmp = tmpdir().replace(/\/+$/, "");
  if (tmp) id.tmps.push(tmp);
  try {
    const realTmp = realpathSync(tmp);
    if (realTmp && realTmp !== tmp) id.tmps.push(realTmp);
  } catch { /* realpath failed */ }
  identityCache = id;
  return id;
}

function redactIdentity(text: string): string {
  const id = identity();
  let out = text;

  if (id.home) out = out.split(id.home).join("~");

  // any /Users/<name> or /home/<name> prefix, also at end of string or inside quotes
  out = out.replace(/\/(Users|home)\/[^/\s"',;()]+/g, "~");

  if (id.user) out = out.replace(id.user, "[USER]");
  for (const re of id.hosts) out = out.replace(re, "[HOST]");

  for (const tmp of id.tmps) out = out.split(tmp).join("[TMP]");
  // any other /var/folders/<x>/<y>/T form (macOS per-user temp roots)
  out = out.replace(/(?:\/private)?\/var\/folders\/[^/\s"',;()]+\/[^/\s"',;()]+\/T\b/g, "[TMP]");

  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

const uniqueStrings = (values: unknown[]) =>
  [...new Set(values.filter((v): v is string => typeof v === "string" && v.length > 0))];

/**
 * Redacts sensitive information from a string.
 * Canary tokens (the exact strings in opts.canaries, or - without a list - only
 * strings in the exact canary format) are preserved. Everything else that looks
 * like a credential or an email address, in raw, percent-encoded or base64-encoded
 * form, is replaced with [REDACTED] / [EMAIL]. Host identity (home dir, username,
 * hostname, temp paths) is replaced with ~ / [USER] / [HOST] / [TMP].
 */
export function redact(input: string, opts: RedactOptions = {}): string {
  if (!input || typeof input !== "string") return input;

  let text = percentDecode(stripControls(input));

  // Shield canaries before any pattern can touch them; longest first, so a canary that
  // contains another is shielded whole.
  const canaries = opts.canaries
    ? uniqueStrings(opts.canaries)
    : uniqueStrings([...text.matchAll(CANARY_RE)].map((m) => m[0]));
  canaries.sort((a, b) => b.length - a.length);
  text = shield(text, canaries);

  const secrets = uniqueStrings(opts.secrets ?? []).filter((s) => s.length >= 8);
  secrets.sort((a, b) => b.length - a.length);

  text = redactSecretPatterns(text, secrets);
  text = redactBase64Runs(text, { canaries, formatMode: !opts.canaries, secrets }, 0);
  text = redactIdentity(text);

  // Unshield.
  canaries.forEach((c, i) => {
    const p = placeholder(i);
    if (text.includes(p)) text = text.split(p).join(c);
  });

  return text;
}

const HOST_SECRET_NAME_RE = /(TOKEN|KEY|SECRET|PASS|AUTH|SESSION|COOKIE|CREDENTIAL)/i;

/**
 * Values from the host environment that must never survive into published evidence:
 * every variable whose name looks credential-ish, plus any long value containing
 * both letters and digits and no '/' (a path is not a token).
 */
export function collectHostSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  const out = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (!value) continue;
    if (HOST_SECRET_NAME_RE.test(name)) {
      out.add(value);
    } else if (value.length >= 20 && /[A-Za-z]/.test(value) && /[0-9]/.test(value) && !value.includes("/")) {
      out.add(value);
    }
  }
  return [...out];
}
