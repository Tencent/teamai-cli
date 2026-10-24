/**
 * Best-effort secret scrubbing for text that may be persisted or shared.
 *
 * TeamAI's privacy posture is "counts only, no prompt text": aggregated numbers
 * are pushed to the team repo, but raw session content is never uploaded, partly
 * because there was no way to guarantee a leaked token wouldn't ride along.
 * This utility is the missing primitive — a deterministic, dependency-free
 * scrubber that lets callers redact free-form text before it leaves the machine.
 *
 * Two layers, applied in order (ported from the claude-cloud-sync sync hook):
 *   1. Literal masking of known secret *values* (e.g. env vars that look like
 *      credentials). This is 100% precise for values already in the environment.
 *   2. Regex fallback for common secret *shapes* — vendor token prefixes, PEM
 *      private-key blocks, JWTs, `key=value` pairs, `Authorization: Bearer`
 *      headers, and connection-string passwords. This catches secrets pasted
 *      into a conversation that never touched the environment.
 *
 * This is defense-in-depth, not a guarantee: it will not catch every possible
 * secret. Callers should still gate content upload behind explicit opt-in.
 * Run it *after* any analytics extraction so metrics are computed on the
 * original text and remain unaffected by redaction.
 *
 * Why a vendored function rather than a dependency: this runs on the hook hot
 * path (every session event cold-starts the CLI), and teamai-cli keeps a small
 * dependency surface and a Node 20 floor. The mature options don't fit that
 * baseline — external scanners (gitleaks, trufflehog) are separate binaries,
 * and Node-native linters (secretlint) are dev-time, file-oriented, and require
 * a newer runtime. Those tools use the same regex catalog this file does; here
 * it's inlined without the framework weight. A heavier external scanner is best
 * layered on top as an *optional, opt-in deep pass*, not as the always-on floor.
 */

import fs from 'node:fs';
import path from 'node:path';

const PLACEHOLDER = (label: string): string => `<REDACTED:${label}>`;

/** Mask credentials embedded in HTTP(S) Git URLs found in logs or errors. */
export function sanitizeGitUrl(text: string): string {
  return text.replace(/(https?:\/\/)[^/@\s]+@/gi, '$1***@');
}

/**
 * Env var names that mark a value as likely-secret. `PAT` must be a whole
 * `_`-separated segment, or every `*_PATH` variable would match.
 */
const SECRET_NAME_PATTERN = /TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|(?:^|_)PAT(?:_|$)/;

/** Minimum length before an env value is worth masking (avoids masking `KEY=1`). */
export const MIN_ENV_VALUE_LENGTH = 8;

/** Minimum length of a value the team declares secret: a shorter one cannot be told from ordinary text. */
export const MIN_DECLARED_SECRET_LENGTH = 4;

/**
 * (label, regex) pairs matched and replaced wholesale. Order matters: more
 * specific prefixes (e.g. `sk-ant-`) run before broader ones (e.g. `sk-`).
 *
 * A match whose `passedOver` group took part is kept unchanged. That group
 * consumes text where the secret shape failed and would fail again from every
 * later offset, so the scan skips it once instead of rescanning it per offset.
 * Only that name keeps a match, so any other capture group still redacts.
 */
function wasPassedOver(groups: unknown): boolean {
  return typeof groups === 'object' && groups !== null && 'passedOver' in groups && typeof groups.passedOver === 'string';
}

const SECRET_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['pem', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----|(?<passedOver>[\s\S]*))/g],
  ['anthropic', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['openai', /\bsk-(?:(?:proj|svcacct|admin|None)-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{20,}(?![\w-]))/g],
  ['gh_pat', /\bgithub_pat_[A-Za-z0-9_]{22,}/g],
  ['gh_tok', /\bgh[pousr]_[A-Za-z0-9]{20,}/g],
  ['aws', /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[0-9A-Z]{16}\b/g],
  ['slack', /\bxox[baprs]-[A-Za-z0-9-]{10,}/g],
  ['slackhook', /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/g],
  ['google', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['gcp_oauth', /\bya29\.[0-9A-Za-z_-]{20,}/g],
  ['stripe', /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g],
  ['jwt', /\beyJ(?:[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|(?<passedOver>[A-Za-z0-9_-]*))/g],
  ['sendgrid', /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g],
  ['provider', /\b(?:xai-|gsk_|pplx-|sk-or-v1-|dop_v1_|glpat-|shpat_|tfp_|nvapi-|r8_)[A-Za-z0-9_-]{16,}/g],
  // npm and Hugging Face token bodies are purely alphanumeric; allowing `_`
  // would match identifiers like `npm_package_devDependencies_typescript`.
  ['provider', /\b(?:npm_|hf_)[A-Za-z0-9]{16,}(?![\w-])/g],
];

/** `key=value` / `key: value` — mask only the value, keep the key for readability. */
const KV_PATTERN =
  /(secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|password|passwd|auth[_-]?token|private[_-]?key)(["']?\s*[:=]\s*["']?)([A-Za-z0-9._\-/+=]{16,})/gi;

/** `Authorization: Bearer <token>` — keep the scheme, mask the token. */
const BEARER_PATTERN = /\b(bearer\s+)([A-Za-z0-9._-]{16,})/gi;

/** Lowercase words joined by `-`, `_` or `.` read as prose (`Bearer authentication-scheme`), not a token. */
const JOINED_WORDS_PATTERN = /^[a-z]+(?:[-_.][a-z]+)+$/;

/** `proto://user:PASSWORD@host` — mask only the password segment. */
const CONNECTION_STRING_PATTERN =
  /(?<![a-zA-Z0-9+.-])([0-9+.-]*[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:/@]+:)([^\s/@]{6,})(@)/g;

export interface RedactOptions {
  /**
   * Literal secret values to mask, keyed by the label shown in the placeholder
   * (typically the source env var name). Use {@link collectEnvSecrets} to build
   * this from `process.env`.
   */
  envSecrets?: Record<string, string>;
  /** Apply the built-in secret-shape patterns. Default: `true`. */
  patterns?: boolean;
}

/**
 * Scan an environment map for values that look like credentials, keyed by var
 * name. Kept separate from {@link redact} so redaction stays a pure function of
 * its inputs (and so the env scan can be unit-tested with a fake env).
 */
export function collectEnvSecrets(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string' || value.length < MIN_ENV_VALUE_LENGTH) continue;
    if (!SECRET_NAME_PATTERN.test(name.toUpperCase())) continue;
    // `SSH_KEY_PATH` names where a secret lives, not the secret. Shape alone
    // cannot tell: base64 secrets contain `/` and may start with it.
    if (path.isAbsolute(value) && fs.existsSync(value)) continue;
    secrets[name] = value;
  }
  return secrets;
}

/**
 * Redact likely secrets from `text`. Returns the input unchanged when it is
 * empty or contains nothing that looks secret.
 */
export function redact(text: string, options: RedactOptions = {}): string {
  if (!text) return text;
  let out = text;

  // Layer 1: literal env-value masking. Longest values first so a value that
  // contains a shorter one is masked before the shorter match can fire. A value
  // shorter than MIN_ENV_VALUE_LENGTH only matches as a whole token, so `4938`
  // is not masked inside `build-49381`.
  const envSecrets = options.envSecrets ?? {};
  const entries = Object.entries(envSecrets).sort((a, b) => b[1].length - a[1].length);
  for (const [label, value] of entries) {
    if (!value) continue;
    if (value.length < MIN_ENV_VALUE_LENGTH) {
      const token = new RegExp(`(?<![\\p{L}\\p{N}_])${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'gu');
      out = out.replace(token, () => PLACEHOLDER(label));
    } else if (out.includes(value)) {
      out = out.split(value).join(PLACEHOLDER(label));
    }
  }

  // Layer 2: secret-shape regexes.
  if (options.patterns !== false) {
    for (const [label, pattern] of SECRET_PATTERNS) {
      out = out.replace(pattern, (match: string, ...rest: unknown[]) =>
        wasPassedOver(rest.at(-1)) ? match : PLACEHOLDER(label),
      );
    }
    out = out.replace(KV_PATTERN, (_m, key: string, sep: string) => key + sep + PLACEHOLDER('kv'));
    out = out.replace(BEARER_PATTERN, (match, scheme: string, token: string) =>
      JOINED_WORDS_PATTERN.test(token) ? match : scheme + PLACEHOLDER('authz'),
    );
    out = out.replace(CONNECTION_STRING_PATTERN, (_m, prefix: string, _pw: string, at: string) =>
      prefix + PLACEHOLDER('conn') + at,
    );
  }

  return out;
}

/**
 * A copy of the JSON value `value` with each known secret value masked in every string it holds, as `redact` masks
 * text without the shape patterns. Keys are strings too: output may put a secret in a computed property name.
 */
export function redactJson(value: unknown, envSecrets: Record<string, string>): unknown {
  if (typeof value === 'string') return redact(value, { envSecrets, patterns: false });
  if (Array.isArray(value)) return value.map((item) => redactJson(item, envSecrets));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key, { envSecrets, patterns: false }), redactJson(item, envSecrets)]));
  }
  return value;
}

/**
 * Convenience wrapper: redact using both the built-in patterns and secrets
 * discovered in the current environment.
 */
export function redactWithEnv(text: string, env: NodeJS.ProcessEnv = process.env): string {
  return redact(text, { envSecrets: collectEnvSecrets(env) });
}
