import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildHandlerRegistry } from '../hook-handlers.js';
import { readContributeState, writeContributeState } from '../contribute-check.js';
import { CONTRIBUTE_BASE_THRESHOLD, CONTRIBUTE_SMART_THRESHOLD } from '../types.js';

describe('Codex Stop hint handoff with persisted session state', () => {
  let tmpHome: string;
  const originalHome = process.env.HOME;
  const registry = buildHandlerRegistry();
  const stop = registry.find(r => r.handler.name === 'contribute-check')!.handler;
  const prompt = registry.find(r => r.handler.name === 'pending-hint')!.handler;
  const stdin = { session_id: 'codex-stop-regression', cwd: '/tmp/project' };

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-codex-stop-'));
    process.env.HOME = tmpHome;
  });
  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  async function seed(score: number) {
    await writeContributeState(stdin.session_id, {
      contributed: false,
      smartScore: score,
      toolCount: CONTRIBUTE_BASE_THRESHOLD,
      lastEvaluated: Date.now(),
      friction: { interrupt: 0, toolReject: 0, correction: 1, toolError: 0 },
    });
  }

  it('keeps Stop silent, persists the hint, and delivers it only once on the next prompt', async () => {
    await seed(CONTRIBUTE_SMART_THRESHOLD + 1);
    expect(await stop.execute(stdin, 'codex')).toBeNull();
    const state = await readContributeState(stdin.session_id);
    expect(state.hinted).toBe(true);
    expect(state.pendingHint).toContain('teamai-share-learnings');
    expect(await stop.execute(stdin, 'codex')).toBeNull();
    expect((await readContributeState(stdin.session_id)).pendingHint).toBe(state.pendingHint);
    expect(JSON.parse((await prompt.execute(stdin, 'codex'))!)).toEqual({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: state.pendingHint },
    });
    expect((await readContributeState(stdin.session_id)).pendingHint).toBeUndefined();
    expect(await prompt.execute(stdin, 'codex')).toBeNull();
    expect(await stop.execute(stdin, 'codex')).toBeNull();
  });

  it.each(['codex', 'codex-internal', 'tcodex'])(
    'stashes for %s instead of printing a payload Codex rejects',
    async (tool) => {
      // The variants run the same Codex. Before #719 only the bare name was
      // listed, so they took the Claude branch, Codex rejected it, and the
      // stash that would have recovered the hint never ran.
      await seed(CONTRIBUTE_SMART_THRESHOLD + 1);
      expect(await stop.execute(stdin, tool)).toBeNull();
      expect((await readContributeState(stdin.session_id)).pendingHint).toBeTruthy();
    },
  );

  it('asks the model to relay the stashed copy, and never the copy Claude Code prints', async () => {
    await seed(CONTRIBUTE_SMART_THRESHOLD + 1);

    // Hidden path: the host shows nothing, so the model has to pass it on.
    await stop.execute(stdin, 'codex');
    const stashed = (await readContributeState(stdin.session_id)).pendingHint!;
    expect(stashed).toContain('verbatim');
    expect(stashed).toContain('[teamai]');

    // Displayed path: Claude Code prints the payload itself. An order to print
    // it would reach the user as well, and the nudge would land twice (#719).
    const fresh = { session_id: 'claude-stop-relay', cwd: stdin.cwd };
    await writeContributeState(fresh.session_id, {
      contributed: false,
      smartScore: CONTRIBUTE_SMART_THRESHOLD + 1,
      toolCount: CONTRIBUTE_BASE_THRESHOLD,
      lastEvaluated: Date.now(),
      friction: { interrupt: 0, toolReject: 0, correction: 1, toolError: 0 },
    });
    const payload = JSON.parse((await stop.execute(fresh, 'claude'))!);
    expect(payload.hookSpecificOutput.additionalContext).toContain('[teamai]');
    expect(payload.hookSpecificOutput.additionalContext).not.toContain('verbatim');
  });

  it('does not queue or deliver a hint below threshold', async () => {
    await seed(CONTRIBUTE_SMART_THRESHOLD - 1);
    expect(await stop.execute(stdin, 'codex')).toBeNull();
    expect((await readContributeState(stdin.session_id)).hinted).toBeFalsy();
    expect(await prompt.execute(stdin, 'codex')).toBeNull();
  });

  it('drops a queued hint if the user contributed before the next prompt', async () => {
    await seed(CONTRIBUTE_SMART_THRESHOLD + 1);
    await stop.execute(stdin, 'codex');
    await writeContributeState(stdin.session_id, {
      ...await readContributeState(stdin.session_id), contributed: true,
    });
    expect(await prompt.execute(stdin, 'codex')).toBeNull();
    expect((await readContributeState(stdin.session_id)).pendingHint).toBeUndefined();
  });
});
