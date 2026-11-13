import type { McpFormat } from '@teamai/tool-core/definition';
import crypto from 'node:crypto';
import { z } from 'zod';
import { isJsonObject, type JsonObject, type JsonValue, type McpServerDef, type McpTransport } from '../types.js';
import { sameEnvName } from './env-key.js';

// ─── Per-tool rendering ──────────────────────────────────────
//
//  One McpServerDef renders into three different on-disk shapes:
//
//    claude family   { "type": "http", "url", "headers" }
//    agy             { "url", "headers" }                     (no type at all)
//    cursor          { "url", "headers" }                     (type omitted)
//    copilot         { "type": "local"|"http", ..., "tools": ["*"] }
//    buddy family    { "transportType": "streamable-http", … } (+ timeout)
//    codex           [mcp_servers.<name>] TOML table          (stdio + http)
//    openclaw        { "transport": "stdio|sse|streamable-http", … } (+ requestTimeoutMs)
//    hermes          YAML map: command/args/env, or url/headers (+ timeout seconds)
//    dsh             a patch-list insert: { id, name, config: { transport, serverName, … } }
//
//  Keeping the differences here — rather than in the reconcile engine — is the
//  same split agents uses between agent-format.ts and its handler.

/** The DSH plugin that connects one MCP server; each managed server is one instance of it. */
export const DSH_MCP_PLUGIN = '@deepseek-ai/dsh-mcp-client';

/** DSH's native server identity: the namespace its tool names are built from. */
const DSH_SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** A stable patch-instance id for one managed server. Identity and ownership come from `config.serverName` and the manifest; this only locates the row. */
export function dshMcpPatchId(serverName: string): string {
  return `teamai-mcp-${serverName}`;
}

/** Why `name` cannot be `format`'s native server identity, or null when it can. DSH refuses anything outside `[A-Za-z0-9_-]{1,32}` rather than renaming. */
export function serverNameProblem(format: McpFormat, name: string): string | null {
  if (format !== 'dsh' || DSH_SERVER_NAME_RE.test(name)) return null;

  return `DeepSeek Harness accepts a server name of 1-32 characters from A-Z, a-z, 0-9, "_" and "-"`;
}

const COPILOT_ALL_TOOLS = '*';

/**
 * Top-level JSON key each format stores its server map under. Claude/cursor/buddy
 * all use `mcpServers`; OpenCode uses `mcp`. Codex is TOML (handled separately) and
 * has no entry here. The three native formats only ever read their own file under
 * their own container (`openclaw`'s `mcp` carries `servers` below it, `hermes`'s
 * `mcp_servers` is the map, `dsh`'s `insert` locates a patch list).
 */
export const MCP_SERVER_KEY: Record<Exclude<McpFormat, 'codex'>, string> = {
  pi: 'mcpServers',
  muse: 'mcpServers',
  agy: 'mcpServers',
  claude: 'mcpServers',
  cursor: 'mcpServers',
  buddy: 'mcpServers',
  opencode: 'mcp',
  copilot: 'mcpServers',
  openclaw: 'mcp',
  hermes: 'mcp_servers',
  dsh: 'insert',
};

/** A format whose servers live inside one JSON object under `MCP_SERVER_KEY[format]`; the native files are never shared with another tool. */
const JSON_SERVER_MAP_FORMAT: Record<McpFormat, boolean> = {
  pi: true,
  muse: true,
  agy: true,
  claude: true,
  cursor: true,
  buddy: true,
  opencode: true,
  copilot: true,
  codex: false,
  openclaw: false,
  hermes: false,
  dsh: false,
};

/** Whether two formats keep their servers under one key of a shared file (Claude, Cursor and CodeBuddy all use `mcpServers`). */
export function sameServerKey(a: McpFormat, b: McpFormat): boolean {
  if (a === b) return true;

  if (a === 'codex' || b === 'codex') return false;

  if (!JSON_SERVER_MAP_FORMAT[a] || !JSON_SERVER_MAP_FORMAT[b]) return false;

  return MCP_SERVER_KEY[a] === MCP_SERVER_KEY[b];
}

/** Transports each format can actually express. */
const SUPPORTED_TRANSPORTS: Record<McpFormat, Set<McpTransport>> = {
  pi: new Set<McpTransport>(['stdio', 'http']),
  // Muse Code fails startup validation on a single `type: sse` server and then
  // loads no MCP server at all.
  muse: new Set<McpTransport>(['stdio', 'http']),
  // Antigravity CLI speaks stdio and streamable HTTP; it has no legacy SSE transport.
  agy: new Set<McpTransport>(['stdio', 'http']),
  claude: new Set<McpTransport>(['stdio', 'http', 'sse']),
  cursor: new Set<McpTransport>(['stdio', 'http', 'sse']),
  buddy: new Set<McpTransport>(['stdio', 'http', 'sse']),
  // Codex speaks streamable HTTP (`url` + header keys) as well as stdio, but has
  // no SSE transport, so only that one is skipped.
  codex: new Set<McpTransport>(['stdio', 'http']),
  // OpenCode splits transports into `type: local` (stdio) and `type: remote`
  // (streamable HTTP or SSE, negotiated by its client).
  opencode: new Set<McpTransport>(['stdio', 'http', 'sse']),
  copilot: new Set<McpTransport>(['stdio', 'http', 'sse']),
  // OpenClaw spells the three native transports stdio, sse and streamable-http.
  openclaw: new Set<McpTransport>(['stdio', 'http', 'sse']),
  // Hermes connects stdio, Streamable HTTP (the default for `url`) and legacy SSE (`transport: sse`).
  hermes: new Set<McpTransport>(['stdio', 'http', 'sse']),
  // DSH's mcp-client plugin has only `stdio` and `streamable-http`; there is no SSE transport to select.
  dsh: new Set<McpTransport>(['stdio', 'http']),
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

/** The value `${name}` takes from `vars`: on Windows `${token}` names the `TOKEN` a table holds, one environment variable. */
export function placeholderValue(vars: Record<string, string>, name: string): string | undefined {
  if (Object.hasOwn(vars, name)) return vars[name];
  const other = sameEnvName(Object.keys(vars), name);

  return other === undefined ? undefined : vars[other];
}

/**
 * Substitute ${VAR} throughout a def. Unresolved vars are left as-is and
 * reported, so the caller can skip the server rather than inject a broken one.
 */
export function resolvePlaceholders(def: McpServerDef, vars: Record<string, string>): ResolveResult {
  const missing = new Set<string>();
  const lookup = (name: string): string | undefined => placeholderValue(vars, name);

  const sub = (v: string): string =>
    v.replace(PLACEHOLDER_RE, (whole, name: string) => {
      const val = lookup(name);

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

/** One server's entry in a JSON MCP config, as teamai renders it or a tool saved it. */
export type McpJsonEntry = JsonObject;

function renderClaude(def: McpServerDef): McpJsonEntry {
  const e: McpJsonEntry = { type: def.transport };

  if (def.transport === 'stdio') {
    if (def.command !== undefined) e.command = def.command;

    if (def.args?.length) e.args = def.args;

    if (def.env && Object.keys(def.env).length) e.env = def.env;
  } else {
    if (def.url !== undefined) e.url = def.url;

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
    if (def.command !== undefined) e.command = def.command;

    if (def.args?.length) e.args = def.args.map(toCursorEnvSyntax);

    if (def.env && Object.keys(def.env).length) e.env = mapVals(def.env);
  } else {
    e.type = def.transport;

    if (def.url !== undefined) e.url = toCursorEnvSyntax(def.url);

    if (def.headers && Object.keys(def.headers).length) e.headers = mapVals(def.headers);
  }

  return e;
}

/** Antigravity CLI takes the transport from `command` or `url`, and warns on a `type` key. */
function renderAgy(def: McpServerDef): McpJsonEntry {
  const { type: _transport, ...entry } = renderClaude(def);

  return entry;
}

function renderBuddy(def: McpServerDef): McpJsonEntry {
  const e: McpJsonEntry = {};

  if (def.transport === 'stdio') {
    if (def.command !== undefined) e.command = def.command;

    if (def.args?.length) e.args = def.args;

    if (def.env && Object.keys(def.env).length) e.env = def.env;
  } else {
    // CodeBuddy keys the remote transport off `type`, exactly like the claude
    // family — an older `transportType: "streamable-http"` is ignored, so the
    // Authorization header never ships and the server 401s.
    e.type = def.transport;

    if (def.url !== undefined) e.url = def.url;

    if (def.headers && Object.keys(def.headers).length) e.headers = def.headers;
  }

  if (def.timeout !== undefined) e.timeout = def.timeout;

  return e;
}

/** Copilot requires a transport type and an explicit tool allowlist. */
function renderCopilot(def: McpServerDef): McpJsonEntry {
  const e: McpJsonEntry = {
    type: def.transport === 'stdio' ? 'local' : def.transport,
    tools: [COPILOT_ALL_TOOLS],
  };

  if (def.transport === 'stdio') {
    if (def.command !== undefined) e.command = def.command;
    e.args = def.args ?? [];

    if (def.env && Object.keys(def.env).length) e.env = def.env;
  } else {
    if (def.url !== undefined) e.url = def.url;

    if (def.headers && Object.keys(def.headers).length) e.headers = def.headers;
  }

  if (def.timeout !== undefined) e.timeout = def.timeout;

  return e;
}

/**
 * OpenCode's shape is unlike the others: transport is expressed as
 * `type: "local"` (stdio) or `type: "remote"` (http/sse), a local server's command
 * and args are a single `command` array, env is `environment` (not `env`), and
 * every server carries `enabled: true`.
 */
function renderOpencode(def: McpServerDef): McpJsonEntry {
  const e: McpJsonEntry = {};

  if (def.transport === 'stdio') {
    e.type = 'local';
    // OpenCode folds the executable and its args into one `command` array.
    // The schema guarantees a stdio def has `command`; guard anyway so a
    // malformed def never writes an empty-string executable into opencode.json.
    e.command = [...(def.command ? [def.command] : []), ...(def.args ?? [])];

    if (def.env && Object.keys(def.env).length) e.environment = def.env;
  } else {
    e.type = 'remote';

    if (def.url !== undefined) e.url = def.url;

    if (def.headers && Object.keys(def.headers).length) e.headers = def.headers;
  }

  e.enabled = true;

  return e;
}

/**
 * OpenClaw's `mcp.servers.<name>`: `transport` is explicit (`stdio`, `sse` or
 * `streamable-http`), its own `requestTimeoutMs` is milliseconds, and an HTTP
 * entry may not carry stdio fields (config validation rejects a mixed one).
 */
function renderOpenclaw(def: McpServerDef): McpJsonEntry {
  const entry: McpJsonEntry = { transport: def.transport === 'http' ? 'streamable-http' : def.transport };

  if (def.transport === 'stdio') {
    if (def.command !== undefined) entry.command = def.command;

    if (def.args?.length) entry.args = def.args;

    if (def.env && Object.keys(def.env).length) entry.env = def.env;
  } else {
    if (def.url !== undefined) entry.url = def.url;

    if (def.headers && Object.keys(def.headers).length) entry.headers = def.headers;
  }

  if (def.timeout !== undefined) entry.requestTimeoutMs = def.timeout;

  return entry;
}

/**
 * Hermes's `mcp_servers.<name>`: no `transport` key means Streamable HTTP for a
 * `url`, and `transport: sse` selects legacy SSE; `timeout` is in seconds.
 */
function renderHermes(def: McpServerDef): McpJsonEntry {
  const e: McpJsonEntry = {};

  if (def.transport === 'stdio') {
    if (def.command !== undefined) e.command = def.command;

    if (def.args?.length) e.args = def.args;

    if (def.env && Object.keys(def.env).length) e.env = def.env;
  } else {
    if (def.transport === 'sse') e.transport = 'sse';

    if (def.url !== undefined) e.url = def.url;

    if (def.headers && Object.keys(def.headers).length) e.headers = def.headers;
  }

  // Hermes takes seconds, including fractions; team definitions use milliseconds.
  if (def.timeout !== undefined) e.timeout = def.timeout / 1000;

  return e;
}

/**
 * One DSH patch-list instance of `@deepseek-ai/dsh-mcp-client`: `id` only
 * locates the row, `config.serverName` is the native identity, and the
 * plugin has no SSE transport. `toolCallTimeoutMs` is milliseconds.
 */
function renderDsh(def: McpServerDef): McpJsonEntry {
  const config: McpJsonEntry = { transport: def.transport === 'stdio' ? 'stdio' : 'streamable-http', serverName: def.name };

  if (def.transport === 'stdio') {
    if (def.command !== undefined) config.command = def.command;

    if (def.args?.length) config.args = def.args;

    if (def.env && Object.keys(def.env).length) config.env = def.env;
  } else {
    if (def.url !== undefined) config.url = def.url;

    if (def.headers && Object.keys(def.headers).length) config.headers = def.headers;
  }

  if (def.timeout !== undefined) config.toolCallTimeoutMs = def.timeout;

  return { id: dshMcpPatchId(def.name), name: DSH_MCP_PLUGIN, config };
}

/** Render the JSON-shaped entry for a format. Codex is handled separately (TOML). */
export function renderJsonEntry(format: Exclude<McpFormat, 'codex'>, def: McpServerDef): McpJsonEntry {
  if (format === 'openclaw') return renderOpenclaw(def);

  if (format === 'hermes') return renderHermes(def);

  if (format === 'dsh') return renderDsh(def);

  if (format === 'pi') {
    const entry = renderClaude(def);

    // Pi uses seconds (including fractions); team definitions use milliseconds.
    if (def.timeout !== undefined) entry.timeout = def.timeout / 1000;

    // Omit exposure to keep Pi's native codemode default.
    return entry;
  }

  if (format === 'claude' || format === 'muse') return renderClaude(def);

  if (format === 'agy') return renderAgy(def);

  if (format === 'cursor') return renderCursor(def);

  if (format === 'opencode') return renderOpencode(def);

  if (format === 'copilot') return renderCopilot(def);

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

    for (const [k, v] of Object.entries(env)) {
      const key = k.length > 0 && !/[^A-Za-z0-9_-]/.test(k) ? k : q(k);
      lines.push(`${key} = ${q(v)}`);
    }
  }

  return lines.join('\n') + '\n';
}

/** Stable content hash of a rendered entry, or of any value by its JSON text; drives idempotent rewrites. */
export function entryHash<TValue>(rendered: TValue): string {
  return crypto.createHash('sha1').update(JSON.stringify(rendered)).digest('hex').slice(0, 16);
}

/** A stdio entry as Muse saves it: `command` and no `type`, which Muse infers. */
export const UntypedStdioEntrySchema = z.looseObject({ type: z.undefined().optional(), command: z.string(), url: z.undefined().optional() });

/** Muse saves inferred stdio types and object keys differently; array order remains meaningful. */
export function museEntryHash(rendered: JsonValue | undefined): string {
  let value = rendered;

  if (isJsonObject(value) && UntypedStdioEntrySchema.safeParse(value).success) {
    value = { type: 'stdio', ...value };
  }

  const canonical = JSON.stringify(value, (_key, item: JsonValue) => {
    if (!isJsonObject(item)) return item;

    return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]));
  });

  return crypto.createHash('sha1').update(canonical).digest('hex').slice(0, 16);
}
