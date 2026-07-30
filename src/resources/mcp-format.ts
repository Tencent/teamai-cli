import crypto from 'node:crypto';
import type { McpServerDef, McpTransport } from '../types.js';

// ─── Per-tool rendering ──────────────────────────────────────
//
//  One McpServerDef renders into three different on-disk shapes:
//
//    claude family   { "type": "http", "url", "headers" }
//    cursor          { "url", "headers" }                     (type omitted)
//    buddy family    { "transportType": "streamable-http", … } (+ timeout)
//    codex           [mcp_servers.<name>] TOML table          (stdio + http)
//
//  Keeping the differences here — rather than in the reconcile engine — is the
//  same split agents uses between agent-format.ts and its handler.

export type McpFormat = 'claude' | 'cursor' | 'buddy' | 'codex';

const CLAUDE_TOOLS = new Set(['claude', 'claude-internal', 'tclaude']);
const CURSOR_TOOLS = new Set(['cursor']);
const CODEX_TOOLS = new Set(['codex', 'codex-internal', 'tcodex']);
const BUDDY_TOOLS = new Set(['codebuddy', 'workbuddy']);

export function detectMcpFormat(tool: string): McpFormat | null {
  if (CLAUDE_TOOLS.has(tool)) return 'claude';
  if (CURSOR_TOOLS.has(tool)) return 'cursor';
  if (CODEX_TOOLS.has(tool)) return 'codex';
  if (BUDDY_TOOLS.has(tool)) return 'buddy';
  return null;
}

/** Transports each format can actually express. */
const SUPPORTED_TRANSPORTS: Record<McpFormat, Set<McpTransport>> = {
  claude: new Set<McpTransport>(['stdio', 'http', 'sse']),
  cursor: new Set<McpTransport>(['stdio', 'http', 'sse']),
  buddy: new Set<McpTransport>(['stdio', 'http', 'sse']),
  // Codex speaks streamable HTTP (`url` + header keys) as well as stdio, but has
  // no SSE transport, so only that one is skipped.
  codex: new Set<McpTransport>(['stdio', 'http']),
};

export function supportsTransport(format: McpFormat, transport: McpTransport): boolean {
  return SUPPORTED_TRANSPORTS[format].has(transport);
}

/**
 * Whether the target file keeps the secret out of itself, letting the ${VAR} be
 * written through verbatim rather than resolved onto disk.
 *
 * Always false: teamai resolves every secret to plaintext before writing it.
 * Env-var passthrough was tried per tool, but each tool expands variables under
 * different, fragile conditions — most decisively, IDEs launched from the GUI
 * never inherit the user's shell exports, so a ${VAR} placeholder resolves to
 * empty and the server 401s. Resolving to plaintext makes the token present no
 * matter how the tool is started, at the cost of the value landing on disk (new
 * files are created 0600; users should gitignore project-scope MCP configs).
 */
export function supportsEnvExpansion(
  _format: McpFormat,
  _projectScope: boolean,
  _def?: McpServerDef,
): boolean {
  return false;
}

/** `Authorization: Bearer ${VAR}` — codex re-adds the "Bearer " prefix itself. */
const BEARER_PLACEHOLDER_RE = /^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
/** A header whose entire value is one placeholder. */
const WHOLE_PLACEHOLDER_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

interface CodexHeaderPlan {
  bearerTokenEnvVar?: string;
  envHttpHeaders: Record<string, string>;
  httpHeaders: Record<string, string>;
}

/** Split headers across the three fields codex offers for them. */
export function planCodexHeaders(headers: Record<string, string> = {}): CodexHeaderPlan {
  const plan: CodexHeaderPlan = { envHttpHeaders: {}, httpHeaders: {} };
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'authorization') {
      const bearer = BEARER_PLACEHOLDER_RE.exec(value);
      if (bearer) {
        plan.bearerTokenEnvVar = bearer[1];
        continue;
      }
    }
    const whole = WHOLE_PLACEHOLDER_RE.exec(value);
    if (whole) {
      plan.envHttpHeaders[name] = whole[1];
      continue;
    }
    plan.httpHeaders[name] = value;
  }
  return plan;
}

// ─── Placeholder resolution ──────────────────────────────────

const PLACEHOLDER_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Every ${VAR} referenced anywhere in a def. */
export function referencedVars(def: McpServerDef): string[] {
  const found = new Set<string>();
  const scan = (v: string | undefined): void => {
    if (!v) return;
    for (const m of v.matchAll(PLACEHOLDER_RE)) found.add(m[1]);
  };
  scan(def.url);
  scan(def.command);
  def.args?.forEach(scan);
  Object.values(def.headers ?? {}).forEach(scan);
  Object.values(def.env ?? {}).forEach(scan);
  return [...found];
}

export interface ResolveResult {
  def: McpServerDef;
  /** Vars referenced but not found in the lookup table. */
  missing: string[];
}

/**
 * Substitute ${VAR} throughout a def. Unresolved vars are left as-is and
 * reported, so the caller can skip the server rather than inject a broken one.
 */
export function resolvePlaceholders(def: McpServerDef, vars: Record<string, string>): ResolveResult {
  const missing = new Set<string>();
  const sub = (v: string): string =>
    v.replace(PLACEHOLDER_RE, (whole, name: string) => {
      const val = vars[name];
      if (val === undefined || val === '') {
        missing.add(name);
        return whole;
      }
      return val;
    });
  const subMap = (m: Record<string, string> | undefined): Record<string, string> | undefined =>
    m && Object.fromEntries(Object.entries(m).map(([k, v]) => [k, sub(v)]));

  return {
    def: {
      ...def,
      command: def.command ? sub(def.command) : undefined,
      args: def.args?.map(sub),
      url: def.url ? sub(def.url) : undefined,
      headers: subMap(def.headers),
      env: subMap(def.env),
    },
    missing: [...missing],
  };
}

// ─── Renderers ───────────────────────────────────────────────

export type McpJsonEntry = Record<string, unknown>;

function renderClaude(def: McpServerDef): McpJsonEntry {
  const e: McpJsonEntry = { type: def.transport };
  if (def.transport === 'stdio') {
    e.command = def.command;
    if (def.args?.length) e.args = def.args;
    if (def.env && Object.keys(def.env).length) e.env = def.env;
  } else {
    e.url = def.url;
    if (def.headers && Object.keys(def.headers).length) e.headers = def.headers;
  }
  return e;
}

/**
 * Cursor interpolates `${env:NAME}`, not the bare `${NAME}` our defs carry.
 * Rewrite every placeholder into cursor's syntax; a def whose vars were already
 * resolved has no `${…}` left, so this is a no-op there.
 */
function toCursorEnvSyntax(s: string): string {
  return s.replace(PLACEHOLDER_RE, (_whole, name: string) => `\${env:${name}}`);
}

function renderCursor(def: McpServerDef): McpJsonEntry {
  const mapVals = (m: Record<string, string>): Record<string, string> =>
    Object.fromEntries(Object.entries(m).map(([k, v]) => [k, toCursorEnvSyntax(v)]));
  const e: McpJsonEntry = {};
  if (def.transport === 'stdio') {
    e.command = def.command;
    if (def.args?.length) e.args = def.args.map(toCursorEnvSyntax);
    if (def.env && Object.keys(def.env).length) e.env = mapVals(def.env);
  } else {
    e.type = def.transport;
    e.url = def.url ? toCursorEnvSyntax(def.url) : def.url;
    if (def.headers && Object.keys(def.headers).length) e.headers = mapVals(def.headers);
  }
  return e;
}

function renderBuddy(def: McpServerDef): McpJsonEntry {
  const e: McpJsonEntry = {};
  if (def.transport === 'stdio') {
    e.command = def.command;
    if (def.args?.length) e.args = def.args;
    if (def.env && Object.keys(def.env).length) e.env = def.env;
  } else {
    // CodeBuddy keys the remote transport off `type`, exactly like the claude
    // family — an older `transportType: "streamable-http"` is ignored, so the
    // Authorization header never ships and the server 401s.
    e.type = def.transport;
    e.url = def.url;
    if (def.headers && Object.keys(def.headers).length) e.headers = def.headers;
  }
  if (def.timeout !== undefined) e.timeout = def.timeout;
  return e;
}

/** Render the JSON-shaped entry for a format. Codex is handled separately (TOML). */
export function renderJsonEntry(format: Exclude<McpFormat, 'codex'>, def: McpServerDef): McpJsonEntry {
  if (format === 'claude') return renderClaude(def);
  if (format === 'cursor') return renderCursor(def);
  return renderBuddy(def);
}

/**
 * Render a `[mcp_servers.<name>]` TOML block, including a nested `.env` table.
 *
 * Hand-rolled rather than smol-toml's stringify: we only ever splice this text
 * into an existing config.toml, and a whole-file round-trip through the parser
 * silently drops every user comment in the file.
 */
export function renderCodexBlock(def: McpServerDef): string {
  const q = (s: string): string => JSON.stringify(s);
  const lines = [`[mcp_servers.${def.name}]`];

  if (def.transport === 'http') {
    const inlineTable = (t: Record<string, string>): string =>
      `{ ${Object.entries(t).map(([k, v]) => `${q(k)} = ${q(v)}`).join(', ')} }`;
    lines.push(`url = ${q(def.url ?? '')}`);
    const plan = planCodexHeaders(def.headers);
    if (plan.bearerTokenEnvVar) lines.push(`bearer_token_env_var = ${q(plan.bearerTokenEnvVar)}`);
    if (Object.keys(plan.envHttpHeaders).length > 0) {
      lines.push(`env_http_headers = ${inlineTable(plan.envHttpHeaders)}`);
    }
    if (Object.keys(plan.httpHeaders).length > 0) {
      lines.push(`http_headers = ${inlineTable(plan.httpHeaders)}`);
    }
    if (def.timeout !== undefined) {
      lines.push(`startup_timeout_sec = ${Math.ceil(def.timeout / 1000)}`);
    }
    return lines.join('\n') + '\n';
  }

  lines.push(`command = ${q(def.command ?? '')}`);
  lines.push(`args = [${(def.args ?? []).map(q).join(', ')}]`);
  if (def.timeout !== undefined) {
    lines.push(`startup_timeout_sec = ${Math.ceil(def.timeout / 1000)}`);
  }
  const env = def.env ?? {};
  if (Object.keys(env).length) {
    lines.push('');
    lines.push(`[mcp_servers.${def.name}.env]`);
    for (const [k, v] of Object.entries(env)) lines.push(`${k} = ${q(v)}`);
  }
  return lines.join('\n') + '\n';
}

/** Stable content hash of a rendered entry; drives idempotent rewrites. */
export function entryHash(rendered: unknown): string {
  return crypto.createHash('sha1').update(JSON.stringify(rendered)).digest('hex').slice(0, 16);
}
