import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { injectHooks } from '../../hooks.js';

// ─────────────────────────────────────────────────────────────
// Live AI-tool integration E2E
//
// These tests run the *real* `claude`, `codebuddy`, and `cursor-agent`
// CLIs against a cheap model and assert that the hooks teamai injects
// actually fire end-to-end inside those tools.
//
// How it works (per tool):
//   1. Generate the tool's settings/hooks file with teamai's real
//      `injectHooks()` (the exact on-disk shape shipped in production).
//   2. Rewrite each dispatch command so that:
//        - teamai's data dir (~/.teamai) is redirected to an isolated
//          sandbox HOME (so we never pollute the developer's real
//          ~/.teamai), and
//        - `teamai` resolves to the freshly-built dist/index.js without
//          requiring a global install.
//      Everything else (event names, matchers, structure) stays byte-real.
//   3. Run the CLI non-interactively (`-p`/`--print`) with a cheap model
//      on a prompt that forces a single shell-tool call (so the whole hook
//      lifecycle fires in one run). The Anthropic-compatible CLIs (claude,
//      codebuddy) are pointed at a *real, configurable* API via
//      ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL, so the session starts with
//      an explicit key instead of relying on the developer's interactive
//      login, and narrowly pre-approve only the `echo` command so the tool
//      call is not blocked (no blanket permission bypass). The CLI keeps its
//      real HOME; only the spawned hook subprocess sees the sandbox HOME.
//   4. Assert that teamai's hooks fired end-to-end across the full session
//      lifecycle by checking the sandbox dashboard log contains every
//      expected event: session_start, prompt_submit, tool_use (PostToolUse),
//      and stop.
//
// Gated behind TEAMAI_E2E_LIVE_TOOLS=1 because it needs the real CLIs
// installed and makes (cheap) real model calls — neither of which is
// available on shared CI runners.
//
// Real API credentials (configurable) — used by claude + codebuddy:
//   TEAMAI_E2E_ANTHROPIC_API_KEY   (required; the tool is skipped if unset)
//   TEAMAI_E2E_ANTHROPIC_BASE_URL  (optional; defaults to the CLI's own)
// cursor-agent is not Anthropic-compatible; it stays on its own
// `cursor-agent login` auth and auto-skips until logged in.
//
// Cheap models can be overridden via env:
//   TEAMAI_E2E_CLAUDE_MODEL    (default: claude-haiku-4-5-20251001)
//   TEAMAI_E2E_CODEBUDDY_MODEL (default: claude-haiku-4.5)
//   TEAMAI_E2E_CURSOR_MODEL    (default: auto / cli default)
// ─────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');
const NODE = process.execPath;

const LIVE = process.env.TEAMAI_E2E_LIVE_TOOLS === '1';

// Include ~/.local/bin (cursor-agent's default install dir) on PATH.
const AUGMENTED_PATH = `${path.join(os.homedir(), '.local', 'bin')}:${process.env.PATH ?? ''}`;

// A prompt that forces exactly one shell-tool call. Running a tool is what
// makes the *whole* hook lifecycle fire in a single session — SessionStart,
// UserPromptSubmit, PostToolUse and Stop — so one run exercises every event
// teamai injects.
const PROMPT =
  'Run this shell command using your command-execution tool and show its output: ' +
  'echo PONG. After the tool result comes back, reply with the single word DONE.';

// Extra argv for the Anthropic CLIs so the forced tool call runs without an
// interactive prompt. We narrowly pre-approve only `echo` (NOT all of Bash,
// and NOT --dangerously-skip-permissions) so the spawned agent can run the one
// benign command the prompt asks for and nothing else. Both claude and
// codebuddy accept command-scoped allowlist patterns.
const TOOL_FORCING_ARGS = ['--allowedTools', 'Bash(echo:*)'];

// Every dashboard event teamai's built-in hooks should produce over one
// tool-using session (see builtin-hooks.ts + dashboard-collector mapEventType).
const EXPECTED_EVENTS = ['session_start', 'prompt_submit', 'tool_use', 'stop'] as const;

// Real API credentials for the Anthropic-compatible CLIs (claude, codebuddy).
// Both are configurable so the suite can run against a real key + endpoint
// instead of the developer's interactive login.
const API_KEY = process.env.TEAMAI_E2E_ANTHROPIC_API_KEY ?? '';
const API_BASE_URL = process.env.TEAMAI_E2E_ANTHROPIC_BASE_URL ?? '';

/** Env vars that point an Anthropic-compatible CLI at the configured API. */
function anthropicApiEnv(): Record<string, string> {
  const env: Record<string, string> = { ANTHROPIC_API_KEY: API_KEY };
  if (API_BASE_URL) env.ANTHROPIC_BASE_URL = API_BASE_URL;
  return env;
}

interface RunPlan {
  /** argv passed to the CLI. */
  args: string[];
  /** working directory for the CLI process. */
  cwd: string;
  /** path to the hooks/settings file injectHooks() should write. */
  settingsFile: string;
}

interface ToolSpec {
  /** teamai tool id (drives injectHooks shape + --tool flag). */
  id: 'claude' | 'codebuddy' | 'cursor';
  /** CLI binary name. */
  bin: string;
  /** Cheap model id for this CLI. */
  model: string;
  /** Whether this CLI speaks the Anthropic API (driven by ANTHROPIC_* env). */
  anthropicApi: boolean;
  /**
   * Build the settings/hooks file path + return the argv to run the CLI.
   * `sandbox` is the isolated teamai HOME; `wsDir` is a scratch cwd.
   */
  prepare(sandbox: string, wsDir: string): RunPlan;
}

/** Rewrite teamai dispatch commands to use the sandbox HOME + built dist. */
function redirectHooksFile(filePath: string, sandbox: string): void {
  const raw = fs.readFileSync(filePath, 'utf-8');
  // The real command is: bash -lc "teamai hook-dispatch <event> --tool <t> 2>/dev/null" || true
  // Swap the `teamai hook-dispatch` token for an absolute, sandbox-homed invocation.
  const rewritten = raw.replaceAll(
    'teamai hook-dispatch',
    `HOME='${sandbox}' '${NODE}' '${CLI}' hook-dispatch`,
  );
  fs.writeFileSync(filePath, rewritten, 'utf-8');
}

const CLAUDE_MODEL = process.env.TEAMAI_E2E_CLAUDE_MODEL ?? 'claude-haiku-4-5-20251001';
const CODEBUDDY_MODEL = process.env.TEAMAI_E2E_CODEBUDDY_MODEL ?? 'claude-haiku-4.5';
const CURSOR_MODEL = process.env.TEAMAI_E2E_CURSOR_MODEL ?? '';

const TOOLS: ToolSpec[] = [
  {
    id: 'claude',
    bin: 'claude',
    model: CLAUDE_MODEL,
    anthropicApi: true,
    prepare(sandbox, wsDir) {
      const settings = path.join(sandbox, 'claude-settings.json');
      return {
        args: ['-p', PROMPT, '--model', this.model, '--settings', settings, ...TOOL_FORCING_ARGS],
        cwd: wsDir,
        settingsFile: settings,
      };
    },
  },
  {
    id: 'codebuddy',
    bin: 'codebuddy',
    model: CODEBUDDY_MODEL,
    anthropicApi: true,
    prepare(sandbox, wsDir) {
      const settings = path.join(sandbox, 'codebuddy-settings.json');
      return {
        args: ['-p', PROMPT, '--model', this.model, '--settings', settings, ...TOOL_FORCING_ARGS],
        cwd: wsDir,
        settingsFile: settings,
      };
    },
  },
  {
    id: 'cursor',
    bin: 'cursor-agent',
    model: CURSOR_MODEL,
    anthropicApi: false,
    prepare(_sandbox, wsDir) {
      // cursor-agent has no --settings flag; it reads hooks from the
      // workspace-level .cursor/hooks.json. Run inside an isolated workspace.
      const hooksFile = path.join(wsDir, '.cursor', 'hooks.json');
      const args = ['-p', PROMPT, '--workspace', wsDir, '--trust', '--force'];
      if (this.model) args.push('--model', this.model);
      return { args, cwd: wsDir, settingsFile: hooksFile };
    },
  },
];

/** Detect whether a CLI is installed + has usable credentials. */
function toolStatus(spec: ToolSpec): { ok: boolean; reason: string } {
  const found = spawnSync('bash', ['-lc', `command -v ${spec.bin}`], {
    env: { ...process.env, PATH: AUGMENTED_PATH },
    encoding: 'utf-8',
  });
  if (found.status !== 0 || !found.stdout.trim()) {
    return { ok: false, reason: `${spec.bin} not found on PATH` };
  }
  if (spec.anthropicApi && !API_KEY) {
    return {
      ok: false,
      reason: `no API key — set TEAMAI_E2E_ANTHROPIC_API_KEY to run ${spec.bin}`,
    };
  }
  if (spec.id === 'cursor') {
    const st = spawnSync(spec.bin, ['status'], {
      env: { ...process.env, PATH: AUGMENTED_PATH },
      encoding: 'utf-8',
    });
    const out = `${st.stdout ?? ''}${st.stderr ?? ''}`;
    if (/not logged in/i.test(out)) {
      return { ok: false, reason: 'cursor-agent not logged in (run: cursor-agent login)' };
    }
  }
  return { ok: true, reason: '' };
}

function readEvents(sandbox: string): Array<Record<string, unknown>> {
  const eventsPath = path.join(sandbox, '.teamai', 'dashboard', 'events.jsonl');
  if (!fs.existsSync(eventsPath)) return [];
  return fs
    .readFileSync(eventsPath, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return {};
      }
    });
}

describe('live AI-tool hook integration', () => {
  if (!LIVE) {
    it.skip('skipped — set TEAMAI_E2E_LIVE_TOOLS=1 to run real CLI integration', () => {});
    return;
  }

  for (const spec of TOOLS) {
    const status = toolStatus(spec);

    it.skipIf(!status.ok)(
      `${spec.bin}: teamai hooks fire end-to-end across the session lifecycle (cheap model)`,
      async () => {
        const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `teamai-tool-${spec.id}-`));
        const wsDir = path.join(sandbox, 'ws');
        fs.mkdirSync(wsDir, { recursive: true });

        try {
          const plan = spec.prepare(sandbox, wsDir);

          // 1. Generate the REAL teamai hook file for this tool…
          await injectHooks(plan.settingsFile, spec.id);
          // 2. …then redirect its dispatch commands to the sandbox + built dist.
          redirectHooksFile(plan.settingsFile, sandbox);

          // 3. Run the CLI non-interactively with a cheap model. Anthropic
          //    CLIs get the configured real API key + base URL.
          const res = spawnSync(spec.bin, plan.args, {
            env: {
              ...process.env,
              PATH: AUGMENTED_PATH,
              FORCE_COLOR: '0',
              ...(spec.anthropicApi ? anthropicApiEnv() : {}),
            },
            cwd: plan.cwd,
            encoding: 'utf-8',
            input: '',
            timeout: 90_000,
          });

          // 4. Assert teamai's hooks fired across the whole lifecycle: the
          //    tool-forcing prompt makes one run emit every expected event.
          //    The sandbox HOME is fresh per test, so every event in the log
          //    belongs to this tool's run.
          const events = readEvents(sandbox);
          const seen = new Set(events.map((e) => e.type));
          const diag =
            `stdout:\n${res.stdout}\nstderr:\n${res.stderr}\n` +
            `events:\n${JSON.stringify(events, null, 2)}`;

          for (const ev of EXPECTED_EVENTS) {
            expect(
              seen.has(ev),
              `expected a '${ev}' event from ${spec.bin}, got [${[...seen].join(', ')}].\n${diag}`,
            ).toBe(true);
          }
          // session_start must be attributed to the right tool.
          expect(
            events.find((e) => e.type === 'session_start')?.tool,
            `session_start should be attributed to ${spec.id}.\n${diag}`,
          ).toBe(spec.id);
        } finally {
          fs.rmSync(sandbox, { recursive: true, force: true });
        }
      },
      120_000,
    );
  }
});
