import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LocalConfig } from '../types.js';
import { parseWorkflow } from '../workflow/parse.js';
import { loadCachedWorkflow, syncWorkflowDefinitions } from '../workflow/cache.js';
import { workflowHint, WORKFLOW_HINT_LIMIT } from '../workflow/discovery.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture(): LocalConfig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-invocable-')); dirs.push(dir);
  fs.mkdirSync(path.join(dir, 'repo', 'workflows'), { recursive: true });
  return { repo: { kind: 'self', localPath: path.join(dir, 'repo'), remote: 'local' }, username: 'test', scope: 'project', additionalRoles: [], projectRoot: dir, dataHome: path.join(dir, 'data') };
}
function put(config: LocalConfig, name: string, metadata: string, description = 'Build safely.') {
  fs.writeFileSync(path.join(config.repo.localPath, 'workflows', `${name}.yaml`), `schemaVersion: v1alpha1\nname: ${name}\ndescription: ${description}\n${metadata}\nsteps:\n  - id: work\n    command: echo work\n`);
}

describe('invocable workflow discovery (#1086)', () => {
  it('accepts an explicit invocable opt-in and a command alias', () => {
    const parsed = parseWorkflow('build.yaml', 'schemaVersion: v1alpha1\nname: build\ndescription: Build safely.\ninvocable: true\nalias: ship\nsteps:\n  - id: work\n    command: echo work\n');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.definition).toMatchObject({ invocable: true, alias: 'ship' });
  });
  it('advertises only runnable opted-in workflows and resolves aliases without shadowing names', async () => {
    const config = fixture();
    put(config, 'build', 'invocable: true\nalias: ship'); put(config, 'private', 'alias: hidden');
    put(config, 'broken', 'invocable: true\nalias: "not a token"');
    await syncWorkflowDefinitions(config);
    expect(await workflowHint(config)).toContain('build (alias ship): Build safely.');
    expect(await workflowHint(config)).not.toMatch(/private|broken/);
    expect((await loadCachedWorkflow(config, 'ship'))?.definition.name).toBe('build');
    put(config, 'ship', ''); await syncWorkflowDefinitions(config);
    expect((await loadCachedWorkflow(config, 'ship'))?.definition.name).toBe('ship');
    expect(await workflowHint(config)).not.toContain('(alias ship)');
  });
  it('bounds the injected hint and keeps descriptions on one line', async () => {
    const config = fixture();
    for (let index = 0; index < 40; index++) put(config, `build-${index}`, 'invocable: true', JSON.stringify('line\n'.repeat(100)));
    await syncWorkflowDefinitions(config);
    const hint = await workflowHint(config);
    expect(hint!.length).toBeLessThanOrEqual(WORKFLOW_HINT_LIMIT);
    expect(hint!.split('\n').slice(1).every((line) => line.length <= 400 && /^build-\d+: /.test(line))).toBe(true);
  });
  it('does not advertise a disabled workflow or resolve a duplicate alias', async () => {
    const config = fixture(); put(config, 'a', 'invocable: true\nalias: shared'); put(config, 'b', 'invocable: true\nalias: shared');
    await syncWorkflowDefinitions(config);
    expect(await loadCachedWorkflow(config, 'shared')).toBeNull();
    put(config, 'a', 'invocable: false'); put(config, 'b', 'invocable: false'); await syncWorkflowDefinitions(config);
    expect(await workflowHint(config)).toBeNull();
  });
});
