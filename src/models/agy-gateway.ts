/**
 * The gateway a model switch gives Antigravity CLI, in `~/.teamai/models/agy-env.sh`.
 *
 * agy reads the key from GEMINI_API_KEY and the endpoint from GOOGLE_GEMINI_BASE_URL, which Gemini CLI reads too.
 * So the file defines an `agy` shell function that sets them for agy alone, instead of exporting them: Gemini CLI
 * keeps its own, and a key the member exports later never reaches the gateway. teamai's own agy launches run no
 * shell, so they read the same values back with `agyGatewayEnv`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getUserHome } from '../utils/home.js';
import { shellQuoteValue } from '../utils/shell-profile.js';

export function agyKeyFilePath(): string {
  return path.join(getUserHome(), '.teamai', 'models', 'agy-env.sh');
}

/**
 * The key file's content: `key` is `"${VAR}"` for a key the member's environment holds, else the literal key. An agy
 * alias defined earlier would make the definition a syntax error, so the line before removes it.
 */
export function agyKeyFunction(key: { envRef: string } | { value: string }, baseUrl: string): string {
  const keyValue = 'envRef' in key ? `"\${${key.envRef}}"` : shellQuoteValue(key.value);
  return `unalias agy 2>/dev/null || true\nagy() { GEMINI_API_KEY=${keyValue} GOOGLE_GEMINI_BASE_URL=${shellQuoteValue(baseUrl)} command agy "$@"; }\n`;
}

const SINGLE_QUOTED = String.raw`'(?:[^']|'\\'')*'`;
const KEY_FUNCTION = new RegExp(
  String.raw`^agy\(\) \{ GEMINI_API_KEY=(?:"\$\{([A-Za-z_][A-Za-z0-9_]*)\}"|(${SINGLE_QUOTED})) GOOGLE_GEMINI_BASE_URL=(${SINGLE_QUOTED}) command agy "\$@"; \}$`,
  'm',
);

function unquote(quoted: string): string {
  return quoted.slice(1, -1).replace(/'\\''/g, "'");
}

/**
 * The gateway `content` (an `agyKeyFunction` result) points agy at, with `env` resolving a key it names by variable.
 * An unset variable gives an empty key, as the shell function does, so the member's own GEMINI_API_KEY never goes
 * to the gateway.
 */
export function agyGatewayOf(content: string, env: NodeJS.ProcessEnv): { GEMINI_API_KEY: string; GOOGLE_GEMINI_BASE_URL: string } | undefined {
  const match = KEY_FUNCTION.exec(content);
  if (!match) return undefined;
  const [, envRef, quotedKey, quotedUrl] = match;
  const key = envRef !== undefined ? env[envRef] ?? '' : unquote(quotedKey ?? "''");
  return { GEMINI_API_KEY: key, GOOGLE_GEMINI_BASE_URL: unquote(quotedUrl) };
}

/** What an agy teamai launches needs in its environment while a model switch points agy at a gateway; empty otherwise. */
export function agyGatewayEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  let content: string;
  try {
    content = fs.readFileSync(agyKeyFilePath(), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {};
    throw error;
  }
  return agyGatewayOf(content, env) ?? {};
}
