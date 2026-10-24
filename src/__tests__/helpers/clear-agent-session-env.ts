import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, vi } from 'vitest';
import { homeVariables, isToolId, TOOLS } from '../../tools.js';
import { GIT_REPOSITORY_ENV } from '../../utils/git-env.js';
import { AGENT_SESSION_ENV } from '../../utils/session-id.js';

// Tests run inside an agent's shell (Claude Code sets CLAUDE_CODE_SESSION_ID),
// and recall, contribute and session save read that id through
// agentSessionIdFromEnv; a test that does not isolate HOME would also write
// that live session's state into the real ~/.teamai. Start every test file,
// and the CLIs it spawns, with none set (an OpenCode shell's
// TEAMAI_AGENT_SESSION_ID and a Pi shell's PI_SESSION_ID included).
for (const name of AGENT_SESSION_ENV) {
  delete process.env[name];
}

// The same shell may relocate an agent's root (CLAUDE_CONFIG_DIR, and every
// home `TOOLS[tool].home.moves` names), which teamai honors, so a test that
// stubs only HOME would still read, write or remove the developer's real tool
// files. A test that needs one sets it.
for (const name of ['CLAUDE_CONFIG_DIR', ...Object.keys(TOOLS).filter(isToolId).flatMap(homeVariables)]) {
  delete process.env[name];
}

// Git exports GIT_DIR and the rest to what it runs, as `rebase --exec` does in
// a linked worktree. A fixture's `git init` or `commit` in its temp dir would
// then write to the developer's repository instead: a commit on their branch
// and core.bare=true in its shared config.
for (const name of GIT_REPOSITORY_ENV) {
  delete process.env[name];
}

// Writing Codex hooks makes teamai run `codex app-server` to trust them (#955),
// which would edit the developer's real Codex config. Shadow any `codex` on
// PATH with one that exits at once, so every test file — and the CLIs it
// spawns — sees a failing Codex. A test that needs one prepends the fake from
// helpers/fake-codex.ts.
const shadow = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-no-codex-')));
fs.writeFileSync(path.join(shadow, 'codex'), '#!/bin/sh\nexit 1\n');
fs.chmodSync(path.join(shadow, 'codex'), 0o755);
fs.writeFileSync(path.join(shadow, 'codex.cmd'), '@exit /b 1\r\n');
process.env.PATH = `${shadow}${path.delimiter}${process.env.PATH ?? ''}`;
afterAll(() => {
  fs.rmSync(shadow, { recursive: true, force: true });
});

// The lists above load product modules (session-id.js reaches types.ts and,
// through it, utils/fs.js and utils/logger.js), and a module a setup file
// loaded is cached before a test file's vi.mock applies: the test would mock
// utils/fs.js and still reach the real one through them. Drop them, so each
// test file loads its own, mocked as it asks.
vi.resetModules();
