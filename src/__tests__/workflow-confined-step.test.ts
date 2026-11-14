import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LocalConfig } from '../types.js';
import { runConfinedStep, runConfinedStepOnRuntime, type ConfinedStepLease } from '../workflow/confined-step.js';
import type { AttemptRun } from '../workflow/runtimes/attempt.js';
import { attemptResultPath, AttemptIdSchema, RunIdSchema } from '../workflow/store.js';

let root = '';
let config: LocalConfig;
const run = RunIdSchema.parse('r0c0f1ed0');
const attempt = AttemptIdSchema.parse('a0c0f1ed0');

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-confined-step-')));
  config = { repo: { localPath: path.join(root, 'team'), remote: 'local', kind: 'git' }, username: 'tester', scope: 'user', additionalRoles: [], dataHome: path.join(root, 'data') };
  await fs.mkdir(path.join(root, 'team', 'models'), { recursive: true });
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

/** A directory under `runDir` with `files` in it. */
async function dirWith(runDir: string, name: string, files: Record<string, string>): Promise<string> {
  const dir = path.join(runDir, name);
  await fs.mkdir(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) await fs.writeFile(path.join(dir, file), text);
  return dir;
}

/** A `claude` whose confined profile verifies, and that runs `body` once it read its stdin. */
async function fakeClaude(body: string): Promise<(executable: string) => string | null> {
  const executable = path.join(root, 'claude-fake');
  await fs.writeFile(executable, `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('2.1.308 (Claude Code)'); process.exit(); }
process.stdin.resume(); process.stdin.on('end', () => {
${body}
});\n`, { mode: 0o755 });
  return (name) => (name === 'claude' ? executable : null);
}

function leaseIn(dir: string, extra: Partial<ConfinedStepLease> = {}): ConfinedStepLease {
  return { attempt, step: 'judge', prompt: 'Judge the change in diff.txt.', ...extra, confined: { dir, level: 'verified', tools: ['claude'], ...extra.confined } };
}

describe('runConfinedStep', () => {
  it('runs nothing when no tool of the lease resolves the step model here, and says why for each', async () => {
    await fs.writeFile(path.join(root, 'team', 'models', 'aliases.yaml'), 'aliases:\n  confined-judge:\n    codex: gpt-6-astra\n');
    const dir = await dirWith(root, 'evidence', {});
    const lease = leaseIn(dir, { model: 'confined-judge', confined: { dir, level: 'verified', tools: ['copilot', 'pi', 'claude'] } });

    const ended = await runConfinedStep({ config, run, secrets: {}, lease, resolveTool: () => null });

    expect(ended).toEqual({ kind: 'unresolved', reason: expect.stringMatching(/^Step "judge" runs confined on copilot, pi, claude, and none of them resolves its model here\. copilot is not a tool teamai runs confined\. pi takes no model teamai resolves\. Step "judge" asks for model alias "confined-judge", which has no model for claude/) });
  });

  it('resolves a default model too, and runs nothing when no tool resolves it', async () => {
    await fs.writeFile(path.join(root, 'team', 'models', 'aliases.yaml'), 'aliases:\n  confined-judge:\n    codex: gpt-6-astra\n');
    const dir = await dirWith(root, 'evidence', {});

    const ended = await runConfinedStep({ config, run, secrets: {}, lease: leaseIn(dir, { defaultModel: 'confined-judge' }), resolveTool: await fakeClaude('') });

    expect(ended).toMatchObject({ kind: 'unresolved', reason: expect.stringContaining('gets model alias "confined-judge" from defaults, which has no model for claude') });
  });

  it('stops a tool still running at the lease deadline', async () => {
    const dir = await dirWith(root, 'evidence', {});
    const resolveTool = await fakeClaude(`setTimeout(() => console.log(JSON.stringify({ type: 'result', structured_output: { verdict: 'pass' } })), 3000);`);

    const ended = await runConfinedStep({ config, run, secrets: {}, lease: leaseIn(dir, { expiresAt: new Date(Date.now() + 300).toISOString() }), resolveTool });

    expect(ended).toMatchObject({ kind: 'ran', report: { outcome: 'failed', failure: { code: 'confined_failed' } } });
  });

  it('stops at once a tool whose lease deadline already passed', async () => {
    const dir = await dirWith(root, 'evidence', {});
    const resolveTool = await fakeClaude(`setTimeout(() => console.log(JSON.stringify({ type: 'result', structured_output: { verdict: 'pass' } })), 2000);`);

    const ended = await runConfinedStep({ config, run, secrets: {}, lease: leaseIn(dir, { expiresAt: new Date(Date.now() - 60_000).toISOString() }), resolveTool });

    expect(ended).toMatchObject({ kind: 'ran', report: { outcome: 'failed', failure: { code: 'confined_failed' } } });
  });

  it('fails the step confined_invalid when its reply schema is no longer JSON', async () => {
    const dir = await dirWith(root, 'evidence', { 'reply.json': '{' });

    const ended = await runConfinedStep({ config, run, secrets: {}, lease: leaseIn(dir, { confined: { dir, level: 'verified', tools: ['claude'], schema: path.join(dir, 'reply.json') } }), resolveTool: await fakeClaude('') });

    expect(ended).toEqual({ kind: 'ran', report: { outcome: 'failed', tool: 'claude', message: expect.stringContaining('which is no longer a JSON file'), failure: { code: 'confined_invalid', message: expect.stringContaining(path.join(dir, 'reply.json')) } } });
  });

  it('keeps the output of a tool that failed in the attempt result file, which the failure names', async () => {
    const dir = await dirWith(root, 'evidence', {});
    const resolveTool = await fakeClaude("console.log('rate limited'); process.exit(3);");

    const ended = await runConfinedStep({ config, run, secrets: {}, lease: leaseIn(dir), resolveTool });

    const file = attemptResultPath(config, run, attempt);
    expect(ended).toMatchObject({ kind: 'ran', report: { outcome: 'failed', tool: 'claude', failure: { code: 'confined_failed', message: expect.stringContaining(` The tool's output is in ${file}.`) } } });
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ raw: expect.stringContaining('rate limited') });
  });

  it('fails the step usage_limited, with what the tool said, when the tool stops on its usage limit', async () => {
    const dir = await dirWith(root, 'evidence', {});
    const resolveTool = await fakeClaude(`console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit · resets 3pm (Europe/Madrid)" })); process.exit(1);`);

    const ended = await runConfinedStep({ config, run, secrets: {}, lease: leaseIn(dir), resolveTool });

    expect(ended).toMatchObject({ kind: 'ran', report: { outcome: 'failed', tool: 'claude', failure: { code: 'usage_limited', message: expect.stringMatching(/^claude hit its usage limit: You've hit your limit · resets 3pm \(Europe\/Madrid\)/) } } });
    // The step fails rather than waiting for the reset, so it says how to run it again then.
    expect(ended).toMatchObject({ report: { failure: { message: expect.stringMatching(/ Then run: teamai workflow retry r0c0f1ed0 judge$/) } } });
  });

  it('masks the run\'s secrets in the output it keeps of a tool that failed, before anything else reads the file', async () => {
    const dir = await dirWith(root, 'evidence', {});
    const resolveTool = await fakeClaude("console.log('401 Unauthorized: token tm-judge-credential-0451 was rejected'); process.exit(3);");

    await runConfinedStep({ config, run, lease: leaseIn(dir), resolveTool, secrets: { JUDGE_TOKEN: 'tm-judge-credential-0451' } });

    const kept = await fs.readFile(attemptResultPath(config, run, attempt), 'utf8');
    expect(kept).toContain('401 Unauthorized');
    expect(kept).not.toContain('tm-judge-credential-0451');
  });

  it('runs with a reply schema that is JSON, and counts the tokens the tool reported of either kind', async () => {
    const dir = await dirWith(root, 'evidence', { 'reply.json': '{"type":"object"}' });
    const resolveTool = await fakeClaude(`console.log(JSON.stringify({ type: 'result', structured_output: { verdict: 'fail' }, usage: { input_tokens: 7 } }));`);

    const ended = await runConfinedStep({ config, run, secrets: {}, lease: leaseIn(dir, { confined: { dir, level: 'verified', tools: ['claude'], schema: path.join(dir, 'reply.json') } }), resolveTool });

    expect(ended).toMatchObject({ kind: 'ran', report: { outcome: 'success', outputs: { verdict: 'fail' }, tokens: { input: 7 } } });
  });

  it('reports the reply as outputs, with the model, tokens and run the tool reported', async () => {
    const dir = await dirWith(root, 'evidence', { 'diff.txt': 'retries 3' });
    const resolveTool = await fakeClaude(`console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-fixture' }));
console.log(JSON.stringify({ type: 'result', structured_output: { verdict: 'pass' }, usage: { input_tokens: 12, output_tokens: 3 } }));`);

    const ended = await runConfinedStep({ config, run, secrets: {}, lease: leaseIn(dir), resolveTool });

    expect(ended).toEqual({ kind: 'ran', report: {
      outcome: 'success', tool: 'claude', outputs: { verdict: 'pass' }, model: 'claude-fixture', tokens: { input: 12, output: 3 }, durationMs: expect.toSatisfy((ms: number) => ms >= 0 && ms < 60_000),
      confined: { tool: 'claude', model: { reported: 'claude-fixture' }, isolation: 'verified', access: 'read', usage: { inputTokens: 12, outputTokens: 3 } },
    } });
  });

  it('keeps the alias the step asked for beside the model it resolved to, so a label names the alias its judge ran', async () => {
    await fs.writeFile(path.join(root, 'team', 'models', 'aliases.yaml'), 'aliases:\n  judge:\n    claude: sonnet\n');
    const dir = await dirWith(root, 'evidence', { 'diff.txt': 'retries 3' });
    const resolveTool = await fakeClaude(`console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-fixture' }));
console.log(JSON.stringify({ type: 'result', structured_output: { verdict: 'pass' } }));`);

    const ended = await runConfinedStep({ config, run, secrets: {}, lease: leaseIn(dir, { model: 'judge' }), resolveTool });

    expect(ended).toMatchObject({ kind: 'ran', report: { confined: { model: { alias: 'judge', requested: 'sonnet', reported: 'claude-sonnet-fixture' } } } });
  });
});

describe('runConfinedStepOnRuntime', () => {
  /** An attempt on a runtime that answers confined prompts: `duringOpen` runs while its place opens; prompts are counted. */
  function judgeRun(duringOpen: () => void, ended: Awaited<ReturnType<AttemptRun['prompt']>> = { kind: 'finished', session: { tool: 'claude', id: 's-1' }, result: { output: { label: 'good' } }, confined: { level: 'best-effort', access: 'read' } }): { attemptRun: AttemptRun; prompts: () => number } {
    let prompts = 0;

    const attemptRun: AttemptRun = {
      open: async () => {
        duringOpen();

        return { ok: true, handle: 'h-1' };
      },
      exec: async () => ({ kind: 'failed', failure: { code: 'exec_unsupported', message: 'judge only' } }),
      setup: async () => ({ kind: 'failed', failure: { code: 'exec_unsupported', message: 'judge only' } }),
      prompt: async () => {
        prompts += 1;

        return ended;
      },
      cancel: async () => {},
      stop: async () => {},
      collect: async () => undefined,
      close: async () => undefined,
      stopLeftSetup: async () => undefined,
      closeForRemadeFolder: async () => undefined,
      stopLeftOperation: async () => undefined,
    };

    return { attemptRun, prompts: () => prompts };
  }

  it('sends no prompt when the run is stopped while the place of the confined prompt opens, and ends the step stopped', async () => {
    const dir = await dirWith(root, 'evidence', { 'diff.txt': '+ a line\n' });
    const controller = new AbortController();
    const { attemptRun, prompts } = judgeRun(() => controller.abort());
    const lease = { ...leaseIn(dir), confined: { dir, level: 'best-effort' as const, tools: ['claude'] } };

    const ended = await runConfinedStepOnRuntime({ config, run, secrets: {}, lease, signal: controller.signal, runtime: 'toy', attemptRun, offers: [{ level: 'best-effort', access: 'read', tools: ['claude'] }], credentials: {} });

    expect(ended).toMatchObject({ kind: 'ran', report: { outcome: 'failed', failure: { code: 'confined_failed', message: 'The confined claude prompt on step runtime "toy" was stopped before it replied.' } } });
    expect(prompts()).toBe(0);
  });

  // A benchmark reads a label whose judge names no alias as one its pinned judge did not give.
  it('keeps the alias the step asked for beside the model it resolved to, as a judge here does', async () => {
    await fs.writeFile(path.join(root, 'team', 'models', 'aliases.yaml'), 'aliases:\n  judge:\n    claude: sonnet\n');
    const dir = await dirWith(root, 'evidence', { 'diff.txt': '+ a line\n' });
    const { attemptRun } = judgeRun(() => undefined);
    const lease = { ...leaseIn(dir, { model: 'judge' }), confined: { dir, level: 'best-effort' as const, tools: ['claude'] } };

    const ended = await runConfinedStepOnRuntime({ config, run, secrets: {}, lease, signal: new AbortController().signal, runtime: 'toy', attemptRun, offers: [{ level: 'best-effort', access: 'read', tools: ['claude'] }], credentials: {} });

    expect(ended).toMatchObject({ kind: 'ran', report: { outcome: 'success', confined: { model: { alias: 'judge', requested: 'sonnet' } } } });
  });

  // A benchmark verifies its pinned judge by the model the tool reported, and sums what each judge cost.
  it('reports the model and cost the runtime says the tool ran on', async () => {
    const dir = await dirWith(root, 'evidence', { 'diff.txt': '+ a line\n' });
    const cost = { amount: 0.02, unit: 'USD' };
    const { attemptRun } = judgeRun(() => undefined, { kind: 'finished', session: { tool: 'claude', id: 's-1' }, result: { output: { label: 'good' } }, confined: { level: 'best-effort', access: 'read' }, model: 'claude-sonnet-4-5', cost });
    const lease = { ...leaseIn(dir, { model: 'sonnet' }), confined: { dir, level: 'best-effort' as const, tools: ['claude'] } };

    const ended = await runConfinedStepOnRuntime({ config, run, secrets: {}, lease, signal: new AbortController().signal, runtime: 'toy', attemptRun, offers: [{ level: 'best-effort', access: 'read', tools: ['claude'] }], credentials: {} });

    expect(ended).toMatchObject({ kind: 'ran', report: { outcome: 'success', cost, confined: { model: { requested: 'sonnet', reported: 'claude-sonnet-4-5' }, usage: { cost } } } });
  });

  const limited = 'claude reached its usage limit on T3 Code provider instance "claudeAgent" (Claude): You\'ve hit your limit · resets 3pm (Europe/Madrid)';

  it.each([
    ['fails the prompt', { kind: 'failed', failure: { code: 'usage_limited', message: limited } }],
    ['finishes the prompt with a failure', { kind: 'finished', session: { tool: 'claude', id: 's-1' }, result: { failure: { code: 'usage_limited', message: limited } }, confined: { level: 'best-effort', access: 'read' } }],
  ] as const)('fails the step usage_limited, with what the runtime said, when the runtime %s on the tool\'s usage limit', async (_, end) => {
    const dir = await dirWith(root, 'evidence', { 'diff.txt': '+ a line\n' });
    const { attemptRun } = judgeRun(() => undefined, end);
    const lease = { ...leaseIn(dir), confined: { dir, level: 'best-effort' as const, tools: ['claude'] } };

    const ended = await runConfinedStepOnRuntime({ config, run, secrets: {}, lease, signal: new AbortController().signal, runtime: 'toy', attemptRun, offers: [{ level: 'best-effort', access: 'read', tools: ['claude'] }], credentials: {} });

    expect(ended).toMatchObject({ kind: 'ran', report: { outcome: 'failed', failure: { code: 'usage_limited', message: expect.stringContaining(limited) } } });
    expect(ended).toMatchObject({ report: { failure: { message: expect.stringMatching(/ Then run: teamai workflow retry r0c0f1ed0 judge$/) } } });
  });
});
