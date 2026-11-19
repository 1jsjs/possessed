// Redaction - removes credential patterns and home directory paths from output

import { homedir } from "node:os";
import { resolve, basename } from "node:path";

/**
 * Redacts sensitive information from a string.
 * Returns a new string with credentials and home paths replaced with [REDACTED].
 * Canary tokens (containing HAUNT-CANARY-) are preserved.
 */
export function redact(input: string): string {
  let result = input;

  // Preserve canary tokens - temporarily replace them with placeholders
  // (unique tokens, every occurrence; the same canary often appears several times)
  const canaryTokens = [...new Set(result.match(/HAUNT-CANARY-[a-zA-Z0-9_-]+-[0-9a-f]{16,}/g) || [])];
  const canaryPlaceholders: Record<string, string> = {};
  canaryTokens.forEach((token, index) => {
    canaryPlaceholders[token] = `__CANARY_PLACEHOLDER_${index}__`;
    result = result.replaceAll(token, canaryPlaceholders[token]);
  });

  // 1. AWS access key IDs: AKIA[0-9A-Z]{16}
  result = result.replace(/AKIA[0-9A-Z]{16}/g, "[REDACTED]");

  // 2. AWS secret access keys (40-char base64 following AWS access key on same/adjacent line)
  // This is a heuristic - look for 40-char base64 after an AKIA pattern
  result = result.replace(/(?:^|[^\w])([A-Za-z0-9\/+=]{40})(?:$|[^\w])/g, (match, key) => {
    // Simple heuristic: if it's 40 chars of base64, redact it
    // This may catch non-AWS secrets, but better safe than sorry
    // Git object ids are 40 hex chars and are evidence, not secrets
    if (/^[0-9a-f]{40}$/.test(key)) return match;
    return key.length === 40 && /^[A-Za-z0-9\/+=]+$/.test(key) ? "[REDACTED]" : match;
  });

  // 3. GitHub tokens: ghp_ and github_pat_
  result = result.replace(/ghp_[A-Za-z0-9]{36}/g, "[REDACTED]");
  result = result.replace(/github_pat_[A-Za-z0-9_]{82}/g, "[REDACTED]");

  // 4. OpenAI / Anthropic API keys: sk-[A-Za-z0-9]{32,}
  result = result.replace(/sk-ant-[A-Za-z0-9_-]{20,}/g, "[REDACTED]");
  result = result.replace(/sk-[A-Za-z0-9_-]{32,}/g, "[REDACTED]");

  // 4b. Kiro API keys
  result = result.replace(/ksk_[A-Za-z0-9_-]{16,}/g, "[REDACTED]");

  // 5. PEM private key blocks
  result = result.replace(
    /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----/g,
    "[REDACTED]"
  );

  // 6. Absolute paths under user's home directory
  const homeDir = homedir();
  if (homeDir) {
    const homePattern = new RegExp(escapeRegExp(homeDir) + "/([^/]+)", "g");
    result = result.replace(homePattern, "[REDACTED]/$1");
  }

  // Restore canary tokens
  Object.entries(canaryPlaceholders).forEach(([token, placeholder]) => {
    result = result.replaceAll(placeholder, token);
  });

  return result;
}

// Helper to escape regex special characters
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}