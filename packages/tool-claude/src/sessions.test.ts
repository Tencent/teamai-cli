import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { replayTranscript } from '@teamai/tool-testing/replay-transcript';
import { fixtureText } from '@teamai/tool-testing/conformance';
import { platforms } from './sessions.js';

// Each expected directory name is one Claude Code wrote itself: `claude -p` run from the cwd, then the name it created
// under projects/ listed. 2.1.319 on macOS, 2026-11-08, and the long cut at 2.1.316 on Linux, as sandcastle records it.
const LONG_MAC = `/private/tmp/w7claude.8PY1/${'a'.repeat(120)}/${'b'.repeat(120)}`;
const LONG_MAC_DIR = `-private-tmp-w7claude-8PY1-${'a'.repeat(120)}-${'b'.repeat(52)}-ekg0kz`;
const LONG_LINUX = `/tmp/enc-5jbL/${'a'.repeat(120)}/${'b'.repeat(120)}`;
const LONG_LINUX_DIR = `-tmp-enc-5jbL-${'a'.repeat(120)}-${'b'.repeat(65)}-oy0ktj`;

const SESSION_ID = '28b08950-3966-4119-870a-2d94ce9713c7';
const transcript = fixtureText(new URL('./fixtures/claude-code-transcript.jsonl', import.meta.url));
const made: string[] = [];

afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function store(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-claude-store-'));

  made.push(dir);

  return dir;
}

/** The recorded transcript, written where Claude Code wrote it: `<store>/<dir>/<id>.jsonl`. */
function placed(root: string, dir: string, cwd: string): void {
  replayTranscript({ text: transcript, place: () => path.join(root, dir, `${SESSION_ID}.jsonl`), userText: '' }, { store: root, cwd, sessionId: SESSION_ID });
}

describe('Claude Code project directories', () => {
  it.each([
    { cwd: '/home/me/repo/.sandcastle/worktrees/sandcastle_2026.x', dir: '-home-me-repo--sandcastle-worktrees-sandcastle-2026-x', case: 'dots in a worktree path' },
    { cwd: '/tmp/sp ace/ü~@+=,dir', dir: '-tmp-sp-ace-------dir', case: 'every character that is not an ASCII letter or digit' },
    { cwd: LONG_MAC, dir: LONG_MAC_DIR, case: 'a cwd over 200 characters, on macOS' },
    { cwd: LONG_LINUX, dir: LONG_LINUX_DIR, case: 'a cwd over 200 characters, on Linux' },
  ])('finds the session Claude Code wrote for $case', async ({ cwd, dir }) => {
    const root = store();
    const adapter = platforms['claude-code'].adapter(root);

    placed(root, dir, cwd);

    expect(await adapter.existingSessionId(SESSION_ID, cwd)).toBe(SESSION_ID);
    expect((await adapter.listConversations(cwd)).map((meta) => meta.sessionId)).toEqual([SESSION_ID]);
  });

  it('writes a session for a cwd over 200 characters where Claude Code looks for it', async () => {
    const root = store();
    const adapter = platforms['claude-code'].adapter(root);

    placed(root, '-home-me-repo', '/home/me/repo');
    const session = await adapter.readSession({ sessionId: SESSION_ID, projectPath: '/home/me/repo' });
    const written = await adapter.writeSession(session, LONG_MAC);

    expect(fs.readdirSync(path.join(root, LONG_MAC_DIR))).toContain(`${written}.jsonl`);
  });
});
