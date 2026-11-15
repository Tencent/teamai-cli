import { z } from 'zod';
import { JsonValueSchema } from '@teamai/shared/json';
import { jsonLines, reportedTokens, type ConfinedAccess } from '@teamai/tool-core/launch';
import { extractReply } from '@teamai/tool-core/reply';
import type { TokenUsage } from '@teamai/tool-core/stdout';
import type { ConfinedOffer, ConfinedPrompt, PromptLease, PromptResult, RuntimeFailure } from '@teamai/runtime-protocol';
import { SIGN_IN } from './sign-in.js';

// ─── A judge: one confined prompt, in a container of its own ───
//
//  teamai sends a judge as a `prompt` with `confined: { dir, … }` in a place opened with no view. The runtime starts a
//  fresh container that mounts only `dir`, read-only, on a network whose one way out is a filter that lets through
//  only the model provider's host, and runs the judge's tool there with the env credentials teamai sends:
//
//    claude  -p --tools Read,Grep,Glob --output-format json --json-schema <schema> --append-system-prompt <prompt> <ask>
//    codex   exec --json --ephemeral --output-schema <file> <ask>        the container is its sandbox, so access is full
//
//  A `<tool>: login` stays on this machine: a judge container has no tool home, so a judge brings an API key instead,
//  and `init` offers a judge only on the tools whose keys the definition names (`offersSignedIn`). A judge gets only
//  the names a confined run of its own tool reads (its keys, base URL and model choices), never this machine's proxies or
//  paths, and its filter lets through only the provider it signs in to: the public API, or the base URL its credentials
//  name in place of it. The evidence is mounted at EVIDENCE_DIR, and the prompt names it
//  there, so no mount point, working directory or prompt path tells the judge the member's home, username or project.
//

/** The user turn: the prompt itself goes in as Claude's system prompt, or ahead of this for Codex. */
// A judge told only what it must not do may not even list its evidence, and labels a good pass on nothing.
const ASK = 'List, search and read the files in this directory, and answer from them alone. Change nothing. Return only the requested JSON answer.';

/** Where a judge's container sees the evidence directory, whatever its path on the host. */
export const EVIDENCE_DIR = '/evidence';

/** Where the judge's own files go inside its container, never in `dir`. */
const JUDGE_FILES = '"$HOME/.teamai-judge"';

/** The port the network filter listens on, inside the judge's network. */
export const FILTER_PORT = 3128;

export interface JudgeLaunch {
  argv: string[];
  /** Names the tool's process gets besides the credentials. */
  env: Record<string, string>;
}

export type JudgeReading = { ok: true; session: string; result: PromptResult; usage?: TokenUsage } | { ok: false; message: string };

interface JudgeTool {
  /** What the tool can do in the container beyond answering. */
  access: ConfinedAccess;
  /** The env credentials it signs in with, of those teamai gives a confined prompt on it; a judge with none of them is refused. */
  credentials: readonly string[];
  /** The model provider's `host:port`, and the variable that points the tool at another one. */
  endpoint: string;
  baseUrlEnv: string;
  /** The other names of its confined profile it reads as given, such as the model it picks. */
  settings: readonly string[];
  /** The credentials as the tool reads them: its own of those given, under the names it signs in with. */
  signIn(own: Record<string, string>): Record<string, string>;
  launch(lease: PromptLease, confined: ConfinedPrompt): JudgeLaunch;
  read(stdout: string): JudgeReading;
}

/** Each JSON line of `stdout` that matches `schema`. */
function linesOf<TLine>(stdout: string, schema: z.ZodType<TLine>): TLine[] {
  return jsonLines(stdout).flatMap((line) => {
    const parsed = schema.safeParse(line);

    return parsed.success ? [parsed.data] : [];
  });
}

const ClaudeResult = z.object({
  type: z.literal('result'),
  is_error: z.boolean().optional(),
  session_id: z.string().min(1),
  result: z.string().optional(),
  structured_output: JsonValueSchema.optional(),
  usage: z.object({ input_tokens: z.number().optional(), output_tokens: z.number().optional(), cache_read_input_tokens: z.number().optional() }).optional(),
});

const CodexLine = z.discriminatedUnion('type', [
  z.object({ type: z.literal('thread.started'), thread_id: z.string().min(1) }),
  z.object({ type: z.literal('item.completed'), item: z.object({ type: z.string(), text: z.string().optional() }) }),
  z.object({ type: z.literal('turn.completed'), usage: z.object({ input_tokens: z.number().optional(), cached_input_tokens: z.number().optional(), output_tokens: z.number().optional() }) }),
  z.object({ type: z.literal('turn.failed'), error: z.object({ message: z.string() }) }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);

/** The tools a judge runs on, by executable. */
// oxlint-disable-next-line teamai/tool-facts -- the launch of each tool inside a judge container, which the container confines rather than the tool's own confined profile (src/workflow/confined-launch.ts)
const JUDGE_TOOLS = {
  claude: {
    access: 'read',
    credentials: SIGN_IN.claude.env,
    endpoint: 'api.anthropic.com:443',
    baseUrlEnv: 'ANTHROPIC_BASE_URL',
    settings: ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY'],
    signIn: (own) => own,
    launch: (lease, confined) => ({
      argv: [
        'claude', '-p', '--tools', 'Read,Grep,Glob', '--allowedTools', 'Read,Grep,Glob', '--strict-mcp-config', '--no-session-persistence', '--output-format', 'json',
        ...(confined.schema === undefined ? [] : ['--json-schema', JSON.stringify(confined.schema)]),
        ...(lease.model ? ['--model', lease.model.name] : []), ...(lease.model?.effort ? ['--effort', lease.model.effort] : []),
        '--append-system-prompt', lease.prompt, ASK,
      ],
      // Telemetry and updates would only knock on the filter.
      env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' },
    }),
    read(stdout) {
      const result = linesOf(stdout, ClaudeResult).at(-1);

      if (!result) return { ok: false, message: 'Claude printed no result.' };

      if (result.is_error) return { ok: false, message: `Claude reported an error: ${result.result ?? 'no reason given'}` };
      const output = result.structured_output ?? extractReply(result.result ?? '', JsonValueSchema);
      const usage = reportedTokens({ input: result.usage?.input_tokens, output: result.usage?.output_tokens, cachedInput: result.usage?.cache_read_input_tokens });

      return { ok: true, session: result.session_id, result: output === undefined ? { failure: { code: 'reply_invalid', message: 'Claude did not reply with JSON.' } } : { output }, ...(usage && { usage }) };
    },
  },
  codex: {
    access: 'full',
    credentials: SIGN_IN.codex.env,
    endpoint: 'api.openai.com:443',
    baseUrlEnv: 'OPENAI_BASE_URL',
    settings: [],
    // A fresh Codex home signs in with CODEX_API_KEY, and reads no OPENAI_API_KEY.
    signIn: (own) => (own.CODEX_API_KEY !== undefined || own.OPENAI_API_KEY === undefined ? own : { ...own, CODEX_API_KEY: own.OPENAI_API_KEY }),
    launch: (lease, confined) => ({
      // The schema reaches Codex as a file, written in the container's own home, never in `dir`. Codex takes a base URL
      // from its config, not its env, so the wrapper passes it from the container's env and it stays off every argv.
      argv: [
        '/bin/sh', '-c',
        `mkdir -p ${JUDGE_FILES} && printf '%s' "$JUDGE_SCHEMA" > ${JUDGE_FILES}/schema.json && if [ -n "\${OPENAI_BASE_URL-}" ]; then set -- -c "openai_base_url=\\"$OPENAI_BASE_URL\\"" "$@"; fi && exec codex exec --json --ephemeral --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --output-schema ${JUDGE_FILES}/schema.json "$@"`,
        'codex',
        ...(lease.model ? ['--model', lease.model.name] : []), ...(lease.model?.effort ? ['-c', `model_reasoning_effort=${JSON.stringify(lease.model.effort)}`] : []),
        `${lease.prompt}\n\n${ASK}`,
      ],
      env: { JUDGE_SCHEMA: JSON.stringify(confined.schema ?? { type: 'object' }) },
    }),
    read(stdout) {
      const lines = linesOf(stdout, CodexLine);
      let session: string | undefined;
      let text: string | undefined;
      let failed: string | undefined;
      // An `error` line may be a retry Codex recovers from: it ends the judge only when the turn never completes.
      let notice: string | undefined;
      let completed = false;
      let usage: TokenUsage | undefined;

      for (const line of lines) {
        switch (line.type) {
          case 'thread.started':
            session = line.thread_id;
            break;
          case 'item.completed':
            if (line.item.type === 'agent_message' && line.item.text !== undefined) text = line.item.text;
            break;
          case 'turn.completed':
            completed = true;
            usage = reportedTokens({ input: line.usage.input_tokens, output: line.usage.output_tokens, cachedInput: line.usage.cached_input_tokens });
            break;
          case 'turn.failed':
            failed = line.error.message;
            break;
          case 'error':
            notice = line.message;
            break;
          default: {
            const unhandled: never = line;

            return unhandled;
          }
        }
      }

      const error = failed ?? (completed ? undefined : notice);

      if (error !== undefined) return { ok: false, message: `Codex reported an error: ${error}` };

      if (session === undefined) return { ok: false, message: 'Codex started no thread.' };
      const output = text === undefined ? undefined : extractReply(text, JsonValueSchema);

      return { ok: true, session, result: output === undefined ? { failure: { code: 'reply_invalid', message: 'Codex did not reply with JSON.' } } : { output }, ...(usage && { usage }) };
    },
  },
} satisfies Record<string, JudgeTool>;

/** The judge launch of `tool`, when this runtime judges on it. */
export function judgeTool(tool: string): JudgeTool | undefined {
  return Object.entries(JUDGE_TOOLS).find(([name]) => name === tool)?.[1];
}

function urlOf(text: string): URL | undefined {
  try {
    return new URL(text);
  } catch {
    return undefined;
  }
}

/**
 * The offers a judge can take with the env credentials a definition names (`init.credentials.env`): each tool that
 * signs in with one of them. A login never reaches a judge container, so a login-only tool is left to a later runtime.
 */
export function offersSignedIn(offers: ConfinedOffer[], names: readonly string[]): ConfinedOffer[] {
  return offers.flatMap((offer) => {
    const tools = offer.tools.filter((tool) => judgeTool(tool)?.credentials.some((name) => names.includes(name)) === true);

    return tools.length > 0 ? [{ ...offer, tools }] : [];
  });
}

/**
 * `prompt` with every mention of the evidence directory's host path replaced by where the judge sees it. A mention
 * ends the path, so a sibling such as `<dir>-old` or `<dir>.bak` keeps its host path.
 */
export function inEvidenceDir(prompt: string, dir: string): string {
  return prompt.replace(new RegExp(`${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-]|\\.[\\w-])`, 'g'), EVIDENCE_DIR);
}

/** A judge ready to start: its tool's launch, the hosts its filter lets through, and the credentials it gets. */
export interface Judge {
  tool: JudgeTool;
  hosts: string[];
  credentials: Record<string, string>;
}

/** The first of `names` the member's environment (`shell`) sets, which a hint suggests first, else the first of them. */
function exampleOf(names: readonly string[], shell: NodeJS.ProcessEnv): string {
  return names.find((name) => shell[name]) ?? names[0];
}

/**
 * The judge of `tool` with these credentials, or why it is refused before anything starts, suggesting the sign-in the
 * member's environment (`shell`) sets.
 */
export function judgeOf(tool: string, credentials: Record<string, string>, shell: NodeJS.ProcessEnv): { ok: true; judge: Judge } | { ok: false; failure: RuntimeFailure } {
  const launch = judgeTool(tool);

  if (launch === undefined) return { ok: false, failure: { code: 'tool_unavailable', message: `The sandbox runtime judges on ${Object.keys(JUDGE_TOOLS).join(' or ')}, not ${tool}.` } };

  if (!launch.credentials.some((name) => credentials[name] !== undefined)) {
    return { ok: false, failure: { code: 'credential_missing', message: `A ${tool} judge in the sandbox signs in with ${launch.credentials.join(' or ')}, and the definition gives it none. Add one to the sandbox entry's credentials, for example ${exampleOf(launch.credentials, shell)}: env:${exampleOf(launch.credentials, shell)}. A login stays on this machine and never reaches a judge container.` } };
  }

  const own = Object.fromEntries(Object.entries(credentials).filter(([name]) => [...launch.credentials, launch.baseUrlEnv, ...launch.settings].includes(name)));
  const base = own[launch.baseUrlEnv];

  if (base === undefined) return { ok: true, judge: { tool: launch, hosts: [launch.endpoint], credentials: launch.signIn(own) } };
  const url = urlOf(base);

  if (url === undefined || !['https:', 'http:'].includes(url.protocol)) {
    return { ok: false, failure: { code: 'bad_option', key: 'credentials', message: `${launch.baseUrlEnv} is not an http(s) URL, so the judge's network filter cannot let it through. Set it to the provider's base URL, such as https://llm.acme.internal:8443/v1, and start again.` } };
  }

  return { ok: true, judge: { tool: launch, hosts: [`${url.hostname}:${url.port || (url.protocol === 'http:' ? '80' : '443')}`], credentials: launch.signIn(own) } };
}

/**
 * Why a judge that brings no credential at all is refused when its place opens, suggesting the Claude sign-in the
 * member's environment (`shell`) sets.
 */
export function noJudgeCredential(shell: NodeJS.ProcessEnv): RuntimeFailure {
  const claude = exampleOf(SIGN_IN.claude.env, shell);

  return {
    code: 'credential_missing',
    message: `A judge in the sandbox signs in only with env credentials, and the definition gives the sandbox none: a codex: login stays on this machine and never reaches a judge container. Add one to the sandbox entry's credentials, for example ${claude}: env:${claude} for Claude or OPENAI_API_KEY: env:OPENAI_API_KEY for Codex, and start again.`,
  };
}

/** A filter rule that lets through every host but this machine itself. */
export const ANY_HOST = '*';

/** A filter rule that refuses one address of this machine, as the runtime sees it, which the filter's container cannot tell. */
export const thisMachineRule = (address: string): string => `!${address}`;

/**
 * A filter rule that refuses every address listed in `file`, one per line, read again for each connection, so one this
 * machine gains while the filter runs is refused too; the filter does not start without the file.
 */
export const thisMachineFileRule = (file: string): string => `@${file}`;

/**
 * The network filter, run with `node -e` in a container of the image on the engine's default network and the internal
 * network of the sandbox it filters for: it answers only `CONNECT host:port`, and plain HTTP requests, and pipes the
 * bytes through. Its rules, after its port:
 *
 *   host:port     let through as named: a judge's model provider, or a step's credential on this machine at the name
 *                 the engine gives it (host.docker.internal:8317)
 *   *             every other host, once it resolves only to addresses that are not this machine's: loopback,
 *                 link-local, the network around each of the engine's names for this machine (its VM's other
 *                 addresses), the networks of the filter's own container (other containers), and each `!address` given
 *   !address      an address of this machine as the runtime sees it, such as its LAN address
 *   @file         and every address `file` lists, read again for each connection, which the runtime keeps current
 *
 * A host is resolved once, and the connection goes to the address that was checked, so a name that resolves elsewhere
 * the second time reaches nothing more. It listens only once it knows the engine's names for this machine.
 */
export const FILTER_SCRIPT = String.raw`const net = require('node:net'); const http = require('node:http'); const dns = require('node:dns'); const os = require('node:os'); const fs = require('node:fs');
const [port, ...rules] = process.argv.slice(1);
const files = rules.filter((rule) => rule.startsWith('@')).map((rule) => rule.slice(1));
if (files.some((file) => !fs.existsSync(file))) process.exit(1);
const allowed = rules.filter((rule) => rule !== '*' && !rule.startsWith('!') && !rule.startsWith('@'));
const isOpen = rules.includes('*');
const blocked = new net.BlockList();
const block = (address) => { if (net.isIP(address)) blocked.addAddress(address, net.isIPv6(address) ? 'ipv6' : 'ipv4'); };
for (const [subnet, prefix, family] of [['0.0.0.0', 8, 'ipv4'], ['127.0.0.0', 8, 'ipv4'], ['169.254.0.0', 16, 'ipv4'], ['::', 128, 'ipv6'], ['::1', 128, 'ipv6'], ['fe80::', 10, 'ipv6']]) blocked.addSubnet(subnet, prefix, family);
for (const one of Object.values(os.networkInterfaces()).flat()) if (one && !one.internal) blocked.addSubnet(one.address.split('%')[0], Number(one.cidr.split('/')[1]), one.family === 'IPv6' ? 'ipv6' : 'ipv4');
for (const rule of rules) if (rule.startsWith('!')) block(rule.slice(1));
let listed = { text: undefined, list: new net.BlockList() };
const listedNow = () => {
  const text = files.map((file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return listed.text ?? ''; } }).join('\n');
  if (text !== listed.text) { const list = new net.BlockList(); for (const line of text.split('\n')) { const address = line.trim(); if (net.isIP(address)) list.addAddress(address, net.isIPv6(address) ? 'ipv6' : 'ipv4'); } listed = { text, list }; }
  return listed.list;
};
const isThisMachine = (address) => { const family = net.isIPv6(address) ? 'ipv6' : 'ipv4'; return blocked.check(address, family) || listedNow().check(address, family); };
const unbracketed = (host) => host.replace(/^\[(.*)\]$/, '$1');
// Calls back with where to connect for host:port, or with nothing when the filter does not let it through.
const route = (host, port, done) => {
  if (allowed.includes(host + ':' + port)) { done(unbracketed(host)); return; }
  if (!isOpen) { done(undefined); return; }
  dns.lookup(unbracketed(host), { all: true }, (error, found) => { done(error || found.length === 0 || found.some((one) => isThisMachine(one.address)) ? undefined : found[0].address); });
};
const refuse = (response) => { response.writeHead(403); response.end('This network reaches only what teamai lets through, never this machine itself.\n'); };
const server = http.createServer((request, response) => {
  let url; try { url = new URL(request.url); } catch { refuse(response); return; }
  if (url.protocol !== 'http:') { refuse(response); return; }
  route(url.hostname, url.port || '80', (address) => {
    if (address === undefined) { refuse(response); return; }
    const upstream = http.request({ host: address, port: url.port || 80, method: request.method, path: url.pathname + url.search, headers: request.headers }, (reply) => { response.writeHead(reply.statusCode, reply.headers); reply.pipe(response); });
    upstream.on('error', () => response.destroy()); request.pipe(upstream);
  });
});
server.on('connect', (request, socket, head) => {
  const target = String(request.url);
  const at = target.lastIndexOf(':');
  if (at < 1) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  route(target.slice(0, at), target.slice(at + 1), (address) => {
    if (address === undefined) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const upstream = net.connect(Number(target.slice(at + 1)), address, () => { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); upstream.write(head); upstream.pipe(socket); socket.pipe(upstream); });
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
  });
});
const names = isOpen ? ['host.docker.internal', 'gateway.docker.internal', 'host.containers.internal'] : [];
// The network around each name's address too: the engine's VM has other addresses there, where other containers' ports listen.
const blockAround = (address) => { if (net.isIPv4(address)) blocked.addSubnet(address, 24, 'ipv4'); else if (net.isIPv6(address)) blocked.addSubnet(address, 64, 'ipv6'); };
Promise.all(names.map((name) => new Promise((resolve) => { dns.lookup(name, { all: true }, (error, found) => { for (const one of error ? [] : found) blockAround(one.address); resolve(); }); }))).then(() => server.listen(Number(port), '0.0.0.0'));
process.on('SIGTERM', () => process.exit(0));`;
