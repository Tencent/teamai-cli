import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, vi } from 'vitest';
import { ATTEMPT_ENV, LAUNCHED_BY_ENV, RUN_MODE_ENV } from '../../launch-context.js';
import { GIT_REPOSITORY_ENV } from '../../utils/git-env.js';
import { AGENT_SESSION_ENV } from '../../utils/session-id.js';
import { SESSION_APPS } from '../../workflow/session-apps.js';
import { BUILT_IN_TOOLS } from '@teamai/tool-definitions';
import type { LaunchAdapter } from '@teamai/tool-core/launch';
import { toolRootVariables } from './tool-root-vars.js';

// Tests run inside an agent's shell (Claude Code sets CLAUDE_CODE_SESSION_ID),
// and recall, contribute and session save read that id through
// agentSessionIdFromEnv; a test that does not isolate HOME would also write
// that live session's state into the real ~/.teamai. Start every test file,
// and the CLIs it spawns, with none set (an OpenCode shell's
// TEAMAI_AGENT_SESSION_ID and a Pi shell's PI_SESSION_ID included), and in no
// app's session (a T3 thread sets T3CODE_THREAD_ID), whose driver a describe
// would open. A workflow step that runs the tests carries its runner's
// TEAMAI_WORKFLOW_ATTEMPT, which
// would make a spawned `workflow report --driver skill` that runner, and a
// launched step's TEAMAI_LAUNCHED_BY keeps its sessions out of the totals. CI
// runners set CI, and a shell may set TEAMAI_MODE, either of which makes every
// workflow run here unattended; a test that needs that mode sets it. Both
// vitest configs seed these in `test.env`, so the scrub always has one to remove.
for (const name of [...AGENT_SESSION_ENV, ...SESSION_APPS.map((app) => app.variable), ATTEMPT_ENV, LAUNCHED_BY_ENV, RUN_MODE_ENV, 'CI']) {
  delete process.env[name];
}

// The same shell may relocate an agent's root, which teamai honors, so a test
// that stubs only HOME would still read, write or remove the developer's real
// tool files. The scrub reads the list teamai itself reads (`toolHomeVariableNames`):
// every home `TOOLS[tool].home.moves` names, each `Home.rootVariable`, and the
// roots `init` records in `toolRoots` (`RELOCATABLE_TOOLS`). No instance is loaded
// yet, so an instance's own variable is the test's to set or clear. A test that
// needs one sets it.
for (const name of toolRootVariables()) {
  delete process.env[name];
}

// Git exports GIT_DIR and the rest to what it runs, as `rebase --exec` does in
// a linked worktree. A fixture's `git init` or `commit` in its temp dir would
// then write to the developer's repository instead: a commit on their branch
// and core.bare=true in its shared config.
for (const name of GIT_REPOSITORY_ENV) {
  delete process.env[name];
}

// A step runtime that declares no credential gets the tools' sign-in variables
// found in the member's environment, by name, so the developer's own would
// reach every runtime a test starts. A test that needs one sets it. Read from
// the tools' own adapters, not launch-registry.js: isolate-home.ts mocks that
// module, and a mock a setup file loads keeps the product modules of the setup
// after vi.resetModules below, so its lookups would miss what a test registers.
for (const name of Object.values(BUILT_IN_TOOLS).flatMap((family) => Object.values<LaunchAdapter>(family.launch)).flatMap((adapter) => [...(adapter.signIn?.variables ?? []), ...(adapter.signIn?.alongside ?? [])])) {
  delete process.env[name];
}

// A member who installed teamai's env loader exports BASH_ENV, so every bash a
// test starts (a command step, a hook, a git that is a script) would source
// their real ~/.teamai loader, route the test's directory, and run git for it.
// A test that needs a BASH_ENV sets it.
delete process.env.BASH_ENV;

// Writing Codex hooks makes teamai run `codex app-server` to trust them (#955),
// which would edit the developer's real Codex config. Shadow any `codex` on
// PATH with one that exits at once, so every test file — and the CLIs it
// spawns — sees a failing Codex. A test that needs one prepends the fake from
// @teamai/tool-codex/testing.
const shadow = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-no-codex-')));
fs.writeFileSync(path.join(shadow, 'codex'), '#!/bin/sh\nexit 1\n');
fs.chmodSync(path.join(shadow, 'codex'), 0o755);
fs.writeFileSync(path.join(shadow, 'codex.cmd'), '@exit /b 1\r\n');
process.env.PATH = `${shadow}${path.delimiter}${process.env.PATH ?? ''}`;
afterAll(() => {
  fs.rmSync(shadow, { recursive: true, force: true });
});

// The lists above load product modules (session-id.js reaches types.ts and,
// through it, utils/fs.js and @teamai/shared/log), and a module a setup file
// loaded is cached before a test file's vi.mock applies: the test would mock
// utils/fs.js and still reach the real one through them. Drop them, so each
// test file loads its own, mocked as it asks.
vi.resetModules();
