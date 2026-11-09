import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import { findSkippedFolders, skippedFolderMessage } from '../folder-markers.js';

let repo: string;

async function put(relPath: string, content = 'x\n'): Promise<void> {
  await fse.outputFile(path.join(repo, ...relPath.split('/')), content);
}

beforeEach(async () => {
  repo = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-folder-markers-'));
});

afterEach(async () => {
  await fse.remove(repo);
});

describe('findSkippedFolders', () => {
  it('finds a folder holding its type marker at the root of each type and inside a namespace', async () => {
    const markers = {
      workflows: 'WORKFLOW.yaml',
      hooks: 'HOOK.yaml',
      rules: 'RULE.md',
      mcp: 'MCP.yaml',
      benchmarks: 'SUITE.yaml',
      scorers: 'SCORER.md',
      agents: 'AGENT.md',
    };

    for (const [dir, marker] of Object.entries(markers)) {
      await put(`${dir}/at-root/${marker}`);
      await put(`${dir}/at-root/nested/extra.md`);
      await put(`${dir}/team/in-namespace/${marker}`);
    }

    const skipped = await findSkippedFolders(repo);

    // Hook and rule folders are read (#1787), so only the other types are skipped.
    expect(skipped.map((folder) => folder.path).sort()).toEqual(Object.keys(markers).flatMap((dir) => dir === 'hooks' || dir === 'rules' ? [] : [
      `${dir}/at-root/`,
      `${dir}/team/in-namespace/`,
    ]).sort());
  });

  it('ignores a marker of another type, a lower-case name, and a marker at the type root', async () => {
    await put('rules/wrong-type/WORKFLOW.yaml');
    await put('rules/lower/rule.md');
    await put('workflows/lower/workflow.yaml');
    await put('rules/RULE.md');
    await put('docs/guide/RULE.md');

    expect(await findSkippedFolders(repo)).toEqual([]);
  });

  it('returns nothing for a repo without type directories', async () => {
    expect(await findSkippedFolders(path.join(repo, 'missing'))).toEqual([]);
  });
});

describe('skippedFolderMessage', () => {
  it('names the folder and its kind in one fixed line', () => {
    expect(skippedFolderMessage({ type: 'rules', path: 'rules/api-style/' }))
      .toBe('rules/api-style/ is a rule folder, which this teamai cannot read yet; it was skipped. Run teamai update.');
    expect(skippedFolderMessage({ type: 'mcp', path: 'mcp/github/' }))
      .toBe('mcp/github/ is an MCP server folder, which this teamai cannot read yet; it was skipped. Run teamai update.');
  });
});
