import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LocalConfig } from '../types.js';
import { loadCachedWorkflow, syncWorkflowDefinitions } from '../workflow/cache.js';
import { parseWorkflow } from '../workflow/parse.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function yaml(name: string, header: string): string {
  return `schemaVersion: v1alpha1\nname: ${name}\ndescription: Build safely.\n${header}\nsteps:\n  - id: work\n    command: echo work\n`;
}

function fixture(): LocalConfig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-invoke-')); dirs.push(dir);
  fs.mkdirSync(path.join(dir, 'repo', 'workflows'), { recursive: true });
  return { repo: { kind: 'self', localPath: path.join(dir, 'repo'), remote: 'local' }, username: 'test', scope: 'project', additionalRoles: [], projectRoot: dir, dataHome: path.join(dir, 'data') };
}

function put(config: LocalConfig, name: string, header: string): void {
  fs.writeFileSync(path.join(config.repo.localPath, 'workflows', `${name}.yaml`), yaml(name, header));
}

describe('workflow invoke and alias', () => {
  it.each(['allow', 'ask', 'deny'] as const)('reads invoke: %s', (invoke) => {
    expect(parseWorkflow('workflows/build.yaml', yaml('build', `invoke: ${invoke}`))).toMatchObject({ ok: true, definition: { invoke } });
  });

  it('leaves invoke unset when the file does not write it, which no agent may start', () => {
    const parsed = parseWorkflow('workflows/build.yaml', yaml('build', ''));
    expect(parsed.ok && parsed.definition.invoke).toBeUndefined();
  });

  it.each(['true', 'always', '[allow]'])('refuses invoke: %s with bad_invoke', (value) => {
    expect(parseWorkflow('workflows/build.yaml', yaml('build', `invoke: ${value}`))).toMatchObject({
      ok: false, diagnostics: [{ code: 'bad_invoke', field: 'invoke', message: 'invoke must be allow, ask or deny' }],
    });
  });

  it.each([['"not a token"', 'alias must be a non-empty token'], ['build', 'alias must differ from the workflow name "build"']])('refuses alias: %s with bad_alias', (alias, message) => {
    expect(parseWorkflow('workflows/build.yaml', yaml('build', `alias: ${alias}`))).toMatchObject({
      ok: false, diagnostics: [{ code: 'bad_alias', field: 'alias', message }],
    });
  });

  it('no longer reads invocable', () => {
    expect(parseWorkflow('workflows/build.yaml', yaml('build', 'invocable: true'))).toMatchObject({ ok: false, diagnostics: [{ code: 'unknown_key' }] });
  });

  it('flags an alias another workflow also uses, or takes as its name, and keeps every workflow runnable by name', async () => {
    const config = fixture();
    put(config, 'a', 'alias: shared'); put(config, 'b', 'alias: shared'); put(config, 'c', 'alias: d'); put(config, 'd', '');
    const result = await syncWorkflowDefinitions(config);
    expect(result.cached).toEqual(['a', 'b', 'c', 'd']);
    expect(result.aliasConflicts).toEqual([
      expect.objectContaining({ file: 'workflows/a.yaml', field: 'alias', code: 'alias_conflict', message: 'alias "shared" is also the alias of workflows/b.yaml, so it starts neither; start them by name' }),
      expect.objectContaining({ file: 'workflows/b.yaml', field: 'alias', code: 'alias_conflict', message: 'alias "shared" is also the alias of workflows/a.yaml, so it starts neither; start them by name' }),
      expect.objectContaining({ file: 'workflows/c.yaml', field: 'alias', code: 'alias_conflict', message: 'alias "d" is also the name of workflows/d.yaml, so it starts that workflow; start c by name' }),
    ]);
    expect(await loadCachedWorkflow(config, 'shared')).toBeNull();
    expect((await loadCachedWorkflow(config, 'd'))?.definition.name).toBe('d');
    expect((await loadCachedWorkflow(config, 'a'))?.definition.name).toBe('a');
  });
});
