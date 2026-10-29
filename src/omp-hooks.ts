/**
 * OMP (Oh My Pi) hook injection.
 *
 * OMP has no settings.json-style shell-command hook list. It auto-loads
 * TypeScript *extensions* from the active agent dir — `~/.omp/agent/extensions`
 * by default, moved by a profile (`TOOLS.omp.home`) (`--hook` is an alias of `--extension`, and the legacy
 * `hooks/pre|post` TS files feed the same runner). An extension default-exports
 * a factory that receives the ExtensionAPI; teamai subscribes to OMP's own
 * events and shells out to the same `teamai hook-dispatch` entry point every
 * other agent uses.
 *
 * Event mapping (OMP → teamai dispatch), chosen to mirror the Claude built-in
 * hook set (names verified against the OMP 18.2.5 ExtensionAPI):
 *   - `session_start`      → session-start  (report / sync / ack)
 *   - `session_stop`       → stop           (update / votes / contribute)
 *   - `before_agent_start` → prompt-submit  (track-slash / dashboard; carries `prompt`,
 *                                             and fires for print/RPC sessions too)
 *   - `tool_result`        → post-tool-use  (dashboard; wildcard only)
 *
 * The built-in dispatches run for their side effects and never block the
 * agent: all shell errors are swallowed. The team's own hooks
 * (bridged-team-hooks.ts) run on `session_start`, `before_agent_start`,
 * `tool_call`, `tool_result` and `session_stop` when the team has one on that
 * event: a PreToolUse hook can block a tool call, and what a SessionStart or
 * UserPromptSubmit hook prints joins the system prompt. One built-in dispatch
 * has a result: \`instructions\` returns the member's culture, claudemd and recall
 * blocks for a project session, which \`before_agent_start\` appends to the
 * system prompt (#945). OMP rebuilds that prompt from its base every turn, so
 * the blocks reach each request once. `session_stop` IS awaited
 * by OMP before the main session settles — the dispatch carries its own
 * timeout, and the handler deliberately returns nothing: the `continue` /
 * `decision: "block"` fields of SessionStopEventResult would force a session
 * continuation and change OMP's own stop semantics.
 *
 * Only ONE copy is written, in the user agent dir. OMP also auto-loads project
 * extensions from `<cwd>/.omp/extensions`, and its dedup is absolute-path
 * based — two copies of this file would dispatch every event twice (the same
 * single-copy policy as the OpenCode plugin). Project gating happens inside
 * hook-dispatch, via the `cwd` forwarded on STDIN.
 */

import path from 'node:path';
import { generatedFileState, writeIfChanged, remove } from './utils/fs.js';
import { hookAdapterDir } from './locate.js';
import { log } from './utils/logger.js';
import { resolveCliEntry } from './builtin-hooks.js';
import { bridgedTeamHookFile } from './bridged-team-hooks.js';

/** Filename of the teamai-managed OMP extension. */
export const OMP_HOOK_FILE = 'teamai-hooks.ts';

/** Marker so `teamai uninstall` / `teamai hooks list` can recognize our generated file. */
const TEAMAI_MARKER = '[teamai]';

/**
 * Build the teamai OMP extension source.
 *
 * The extension subscribes to OMP events and shells out to `teamai
 * hook-dispatch <event> --tool omp`, feeding the same JSON payload on STDIN
 * that every other agent's hooks send (`cwd`, `tool_name`, `tool_input`,
 * `prompt`). It uses the Bun shell (`$`) — OMP runs extensions in-process
 * under Bun — with `.quiet().nothrow()` so a missing CLI entry or a
 * non-zero exit never surfaces as an error inside the agent session.
 *
 * OMP-specific bridges, mirroring the OpenCode plugin:
 *   - STDIN payload: hook-dispatch's track / track-slash handlers read
 *     `tool_name` / `tool_input` / `prompt` off STDIN, and the
 *     provider-config gate reads `cwd` to pick the project-scope config.
 *     The extension forwards `ctx.cwd` plus the per-event fields.
 *   - Recall attribution (#884): every event also carries the host's
 *     `session_id` (`ctx.sessionManager.getSessionId()`, a subagent's own
 *     session), and a subagent's events its `agent_id` / `agent_type` from
 *     `ctx.agent`, which only OMP >= 18.3.2 has: it is read only when present.
 *     `tool_result` also carries the tool's text output and a status from
 *     `isError`. A subagent's session file is `<parent>/<agent id>.jsonl`
 *     beside its parent's `<parent>.jsonl`, whose session header (after the
 *     title slot line) names the parent session, so a subagent's
 *     `tool_result` links its session to the parent's, once the parent's file
 *     is on disk; OMP has no API for it. A main session without a session
 *     file (`--no-session`) gives no link.
 *   - Tool naming: OMP passes lowercase tool ids (`bash`, `read`, …) and has
 *     no `Skill` / `TodoWrite` tool to map onto Claude's PascalCase matcher
 *     names, so there is no matcher-scoped pass — only the wildcard
 *     post-tool-use dispatch (the TodoWrite hint's STDOUT channel has no way
 *     back into an OMP session either).
 */
export function buildOmpExtensionSource(): string {
  const launcher = JSON.stringify([process.execPath, resolveCliEntry()]);
  const teamHooksFile = JSON.stringify(bridgedTeamHookFile('omp'));
  return `// ${TEAMAI_MARKER} hooks extension — generated by teamai, do not edit by hand.
//
// Bridges OMP extension events to \`teamai hook-dispatch\`, mirroring the
// Claude built-in hook set. Feeds the same STDIN JSON payload other agents
// send (cwd / session_id / tool_name / tool_input / prompt, a subagent's
// agent_id / agent_type, and on post-tool-use the tool's text output and
// status) so the track / hint / recall handlers and project-scope gating work.
// Errors are swallowed; built-in dispatches run for their side effects (status
// report / sync / update) and never block the agent. The team's hooks run only
// on the events the team has one on: a PreToolUse hook can block a tool call.
//
// NOTE: OMP awaits session_stop before the session settles; this handler
// returns nothing on purpose — the \`continue\` / \`decision\` result fields
// would force a session continuation.

import { $ } from "bun";
import fs from "node:fs";
import path from "node:path";

const launcher = ${launcher};
const TEAM_HOOKS_FILE = ${teamHooksFile};
/** Below OMP's 30 s handler limit, past which it blocks the tool call. */
const TEAM_HOOKS_TIMEOUT_MS = 25000;

/**
 * The session this handler serves (a subagent's own), and for a subagent its
 * identity. ctx.agent exists only from OMP 18.3.2, so each field is read
 * defensively.
 */
const sessionOf = (ctx) => {
  const fields = {};
  try {
    const id = ctx.sessionManager && ctx.sessionManager.getSessionId();
    if (typeof id === "string" && id) fields.session_id = id;
  } catch {}
  const agent = ctx.agent;
  if (agent && agent.kind === "sub" && typeof agent.id === "string" && agent.id) {
    fields.agent_id = agent.id;
    if (typeof agent.name === "string" && agent.name) fields.agent_type = agent.name;
  }
  return fields;
};

/** How much of a session file is read for its header lines. */
const HEADER_READ_BYTES = 65536;

/**
 * The session a subagent's session was started from: its file is
 * <parent>/<agent id>.jsonl, and <parent>.jsonl opens with OMP's title slot
 * line, then the parent's session header. Undefined for any other session,
 * and while the parent's file is not on disk.
 */
const parentSessionOf = (ctx) => {
  try {
    const file = ctx.sessionManager && ctx.sessionManager.getSessionFile && ctx.sessionManager.getSessionFile();
    if (typeof file !== "string" || !file) return undefined;
    const fd = fs.openSync(\`\${path.dirname(file)}.jsonl\`, "r");
    try {
      const head = Buffer.alloc(HEADER_READ_BYTES);
      const size = fs.readSync(fd, head, 0, head.length, 0);
      const [first, second] = head.toString("utf8", 0, size).split("\\n", 2);
      let header = JSON.parse(first);
      if (header && header.type === "title") header = JSON.parse(second);
      return header && header.type === "session" && typeof header.id === "string" && header.id ? header.id : undefined;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
};

/** A tool result's text parts, joined; undefined when it has no content list. */
const textOf = (content) => Array.isArray(content)
  ? content.filter((part) => part && part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\\n")
  : undefined;

/** @param {any} pi OMP ExtensionAPI */
export default function teamaiHooks(pi) {
  // Dispatch one hook event, forwarding a JSON payload on STDIN. \`payload\`
  // fields (cwd / tool_name / tool_input / prompt) match what
  // hook-dispatch's handlers read. No matcher pass: OMP's tool ids are
  // lowercase (bash / read / edit / write / ...) and it has no Skill /
  // TodoWrite tool to map onto Claude's PascalCase matchers.
  const dispatch = async (event, ctx, payload) => {
    try {
      const args = ["hook-dispatch", event, "--tool", "omp"];
      const stdin = JSON.stringify({ cwd: ctx.cwd, ...sessionOf(ctx), ...(payload || {}) });
      // The installed Node/CLI paths do not depend on the host PATH.
      // Redirect the payload into STDIN via a Response (Bun shell can only
      // redirect Response/Buffer/Blob, not a bare string). .quiet() suppresses
      // output; .nothrow() keeps a non-zero exit
      // from throwing into the agent session.
      await $\`\${launcher} \${args} < \${new Response(stdin)}\`.quiet().nothrow();
    } catch {
      // never block the agent
    }
  };

  // The member's culture, claudemd and recall blocks for a project session,
  // or "" (user scope, or teamai unavailable). Fetched once per session.
  let instructions;
  const loadInstructions = async (ctx) => {
    try {
      const stdin = JSON.stringify({ cwd: ctx.cwd, ...sessionOf(ctx) });
      const args = ["hook-dispatch", "instructions", "--tool", "omp"];
      const out = await $\`\${launcher} \${args} < \${new Response(stdin)}\`.quiet().nothrow().text();
      const text = out.trim() ? JSON.parse(out).hookSpecificOutput?.additionalContext : undefined;
      return typeof text === "string" ? text : "";
    } catch {
      return "";
    }
  };

  // The team's hooks for a Claude event (hooks/hooks.yaml), run by
  // \`teamai hook-dispatch <Event> --tool omp --team-hooks\` when the team has
  // one on it: {block} for a PreToolUse hook that refuses, {context} for
  // what a SessionStart or UserPromptSubmit hook adds, else undefined. What a
  // hook that failed or timed out wrote on stderr goes to OMP's console. Never
  // throws: OMP blocks a tool call whose handler throws or runs too long.
  const teamHooks = async (event, ctx, payload) => {
    try {
      const hooks = JSON.parse(fs.readFileSync(TEAM_HOOKS_FILE, "utf8")).hooks;
      if (!hooks || !Array.isArray(hooks[event]) || hooks[event].length === 0) return undefined;
    } catch {
      return undefined;
    }
    let timer;
    try {
      const stdin = JSON.stringify({ cwd: ctx.cwd, ...sessionOf(ctx), ...(payload || {}) });
      const args = ["hook-dispatch", event, "--tool", "omp", "--team-hooks"];
      const run = $\`\${launcher} \${args} < \${new Response(stdin)}\`.quiet().nothrow();
      const result = await Promise.race([run, new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), TEAM_HOOKS_TIMEOUT_MS); })]);
      if (!result) return undefined;
      const err = result.stderr ? String(result.stderr).trimEnd() : "";
      if (err) console.error(err);
      const out = await result.text();
      return out.trim() ? JSON.parse(out) : undefined;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };

  // What the team's SessionStart hooks added at the session's start, for its first turn.
  let started;

  pi.on("session_start", async (_event, ctx) => {
    await dispatch("session-start", ctx);
    instructions = loadInstructions(ctx);
    started = teamHooks("SessionStart", ctx);
  });

  pi.on("session_stop", async (_event, ctx) => {
    await dispatch("stop", ctx);
    await teamHooks("Stop", ctx);
  });

  // OMP rebuilds the system prompt from its base each turn, so appending
  // here adds the blocks to every request once, without piling up. For the
  // same reason the SessionStart hooks run again each turn after the first:
  // what they print follows what a prompt hook changed (#1492).
  pi.on("before_agent_start", async (event, ctx) => {
    // Beside the built-in dispatch, so all fit in OMP's 30 s handler limit. A run an
    // extension starts (messageType "custom") carries no user prompt.
    const session = started ?? teamHooks("SessionStart", ctx);
    started = undefined;
    const team = typeof event.prompt === "string" ? teamHooks("UserPromptSubmit", ctx, { prompt: event.prompt }) : undefined;
    await dispatch("prompt-submit", ctx, { prompt: event.prompt });
    const text = await (instructions ??= loadInstructions(ctx));
    const prompt = await team;
    const added = [text, (await session)?.context, prompt?.context].filter((part) => typeof part === "string" && part);
    return added.length ? { systemPrompt: [...event.systemPrompt, ...added] } : undefined;
  });

  pi.on("tool_call", async (event, ctx) => {
    const decision = await teamHooks("PreToolUse", ctx, { tool_name: event.toolName, tool_input: event.input });
    return decision && typeof decision.block === "string" ? { block: true, reason: decision.block } : undefined;
  });

  // Subagent sessions already linked: a session's parent never changes.
  const linked = new Set();

  // content is what the model saw; isError is set for a failed call,
  // including a bash command that exits non-zero.
  pi.on("tool_result", async (event, ctx) => {
    const payload = {
      tool_name: event.toolName,
      tool_input: event.input,
      tool_response: textOf(event.content),
      tool_status: event.isError === true ? "failure" : event.isError === false ? "success" : "unknown",
    };
    const child = sessionOf(ctx).session_id;
    const parent = child && !linked.has(child) ? parentSessionOf(ctx) : undefined;
    if (parent) {
      payload.session_link = { child, parent };
      linked.add(child);
    }
    await dispatch("post-tool-use", ctx, payload);
    const { session_link: _link, ...team } = payload;
    await teamHooks("PostToolUse", ctx, team);
  });
}
`;
}

/**
 * Inject (or refresh) the teamai OMP extension. Idempotent — writes and
 * reports the extension file only when its content changes. The install gate
 * (~/.omp must exist) lives in the reconcile caller, so this never creates an
 * OMP config dir on its own.
 */
export async function injectOmpHooks(): Promise<void> {
  const file = path.join(hookAdapterDir('omp-extension'), OMP_HOOK_FILE);
  if (await hasForeignOmpHooks()) {
    log.warn(`Skipping OMP hook injection: ${file} exists without the TeamAI marker`);
    return;
  }
  if (await writeIfChanged(file, buildOmpExtensionSource())) {
    log.success(`Injected teamai OMP hook into ${file}`);
  } else {
    log.debug(`teamai OMP hook already up-to-date in ${file}`);
  }
}

/** Remove the teamai OMP extension from `dir`, the active profile's extensions by default, if present. */
export async function removeOmpHooks(dir = hookAdapterDir('omp-extension')): Promise<void> {
  const file = path.join(dir, OMP_HOOK_FILE);
  if (!await hasOmpHooks(dir)) return;
  await remove(file);
  log.success(`Removed teamai OMP hook from ${file}`);
}

const ompHookState = (dir = hookAdapterDir('omp-extension')) => generatedFileState(path.join(dir, OMP_HOOK_FILE), `${TEAMAI_MARKER} hooks extension`);

/** Whether the OMP extension file in `dir`, the active profile's extensions by default, is teamai's. */
export async function hasOmpHooks(dir = hookAdapterDir('omp-extension')): Promise<boolean> {
  return await ompHookState(dir) === 'teamai';
}

async function hasForeignOmpHooks(): Promise<boolean> {
  return await ompHookState() === 'foreign';
}
