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
