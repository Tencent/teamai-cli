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

    // Hook, rule, MCP server and suite folders are read (#1787), so only the other types are skipped.
    expect(skipped.map((folder) => folder.path).sort()).toEqual(Object.keys(markers).flatMap((dir) => ['hooks', 'rules', 'mcp', 'benchmarks'].includes(dir) ? [] : [
      `${dir}/at-root/`,
      `${dir}/team/in-namespace/`,
    ]).sort());
  });

  it('skips no workflow folder: this release reads them', async () => {
    await put('workflows/release/WORKFLOW.yaml');
    await put('workflows/team/deploy/WORKFLOW.yaml');

    expect(await findSkippedFolders(repo)).toEqual([]);
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
    expect(skippedFolderMessage({ type: 'agents', path: 'agents/reviewer/' }))
      .toBe('agents/reviewer/ is an agent folder, which this teamai cannot read yet; it was skipped. Run teamai update.');
    expect(skippedFolderMessage({ type: 'scorers', path: 'scorers/tone/' }))
      .toBe('scorers/tone/ is a scorer folder, which this teamai cannot read yet; it was skipped. Run teamai update.');
  });
});
