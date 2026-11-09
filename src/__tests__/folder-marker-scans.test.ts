import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import { RulesHandler } from '../resources/rules.js';
import { syncWorkflowDefinitions } from '../workflow/cache.js';
import { syncScorerDefinitions } from '../scorers/cache.js';
import { scopeScoring } from '../scorers/settings.js';
import { suiteDirectories } from '../benchmark/suite-cache.js';
import { AgentsHandler } from '../resources/agents.js';
import { listEntryFiles, resolveEntries } from '../namespaced-entries.js';
import { mcpEntryReader } from '../resources/mcp.js';
import { resolveTeamHookEntries } from '../resources/hooks.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

// Each type's team scan leaves out a folder holding that type's reserved
// marker (#1791), at the type root and inside a namespace, and reads the rest
// of the type as before.

let repo: string;
let localConfig: LocalConfig;
const teamConfig = { team: 'markers' } as TeamaiConfig;

async function put(relPath: string, content = 'x\n'): Promise<void> {
  await fse.outputFile(path.join(repo, ...relPath.split('/')), content);
}

beforeEach(async () => {
  repo = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-marker-scans-'));
  localConfig = { repo: { localPath: repo } } as LocalConfig;
});

afterEach(async () => {
  await fse.remove(repo);
});

describe('rules', () => {
  it('delivers no rule from a rule folder and every other rule as before', async () => {
    await put('rules/api-style/RULE.md');
    await put('rules/api-style/RULE.zh.md');
    await put('rules/api-style/checklist.md');
    await put('rules/team/review/RULE.md');
    await put('rules/team/review/more.md');
    await put('rules/team/plain.md');
    await put('rules/lower/rule.md');
    await put('rules/style.md');

    const names = (await new RulesHandler().scanTeamForPull(teamConfig, localConfig)).map((rule) => rule.name).sort();

    expect(names).toEqual(['lower/rule', 'style', 'team/plain']);
  });
});

function workflow(name: string): string {
  return `schemaVersion: v1alpha1\nname: ${name}\ndescription: Fixture workflow.\nsteps:\n  - id: hello\n    command: echo hello\n`;
}

describe('workflows', () => {
  it('reads a workflow folder as the workflow named after its directory, at the root and in a namespace', async () => {
    await put('workflows/ship.yaml', workflow('ship'));
    await put('workflows/release/WORKFLOW.yaml', workflow('release'));
    await put('workflows/release/notes.yaml', workflow('notes'));
    await put('workflows/team/deploy/WORKFLOW.yaml', workflow('deploy'));
    await put('workflows/lower/workflow.yaml', workflow('workflow'));
    const config = { ...localConfig, dataHome: path.join(repo, '.data'), scope: 'project', projectRoot: repo } as LocalConfig;

    const result = await syncWorkflowDefinitions(config, {});

    expect(result.invalid).toEqual([]);
    expect(result.cached.sort()).toEqual(['deploy', 'release', 'ship', 'workflow']);
  });
});

/**
 * Write `file` in `dir` under the marker's name and, on a file system that
 * keeps case, under its lower-case name too: there the older reader finds
 * the marker as `suite.yaml` or `mcp.yaml`, so a folder that carries a
 * lower-case copy is what it would misread elsewhere.
 */
async function putMarkerAndLowerCase(dir: string, marker: string, content: string): Promise<void> {
  await put(`${dir}/${marker}`, content);
  const lower = path.join(repo, ...dir.split('/'), marker.toLowerCase());

  if (!await fse.pathExists(lower)) await fse.outputFile(lower, content);
}

const SCORER = '---\nlabels:\n  - { value: good, score: 1, description: Did the work }\n  - { value: bad, score: 0, description: Did not }\npassingScore: 0.5\n---\nJudge the session.\n';

describe('scorers', () => {
  it('caches no scorer from a scorer folder and reports none of its files', async () => {
    await put('scorers/quality.md', SCORER);
    await put('scorers/style/SCORER.md', SCORER);
    await put('scorers/style/rubric.md', SCORER);
    await put('scorers/team/review/SCORER.md', SCORER);

    const result = await syncScorerDefinitions({ ...localConfig, dataHome: path.join(repo, '.data') }, { dryRun: true, everyNamespace: true });

    expect(result.invalid).toEqual([]);
    expect(result.cached).toEqual(['quality']);
  });

  it('reads no scoring settings from a scorer folder', async () => {
    await put('scorers/style/SCORER.md', SCORER);
    await put('scorers/style/scoring.yaml', 'isolation: [verified\n');

    expect(await scopeScoring({ ...localConfig, scope: 'project', projectRoot: repo, dataHome: path.join(repo, '.data') })).toMatchObject({ ok: true });
  });
});

describe('benchmarks', () => {
  it('reads no suite from a benchmark suite folder, at the root or in a namespace', async () => {
    const suite = 'name: fix\n';
    await put('manifest/roles.yaml', 'version: 1\nroles:\n  - id: dev\n    resources: { knowledge: [], skills: [], benchmarks: [dev] }\n');
    await put('benchmarks/fix/suite.yaml', suite);
    await putMarkerAndLowerCase('benchmarks/api', 'SUITE.yaml', suite);
    await put('benchmarks/dev/lint/suite.yaml', suite);
    await putMarkerAndLowerCase('benchmarks/dev/load', 'SUITE.yaml', suite);

    expect(await suiteDirectories({ ...localConfig, dataHome: path.join(repo, '.data') })).toEqual(['benchmarks/dev/lint', 'benchmarks/fix']);
  });
});

describe('agents', () => {
  it('delivers no agent from an agent folder', async () => {
    await put('agents/coder.yaml', 'name: coder\n');
    await put('agents/reviewer/AGENT.md', '# Reviewer\n');
    await put('agents/reviewer/checklist.md', '# Checklist\n');
    await put('agents/team/helper.yaml', 'name: helper\n');
    await put('agents/team/planner/AGENT.md', '# Planner\n');
    await put('agents/team/planner/planner.yaml', 'name: planner\n');

    const names = (await new AgentsHandler().scanTeamForPull(teamConfig, localConfig)).map((agent) => agent.name).sort();

    expect(names).toEqual(['coder', 'helper']);
  });
});

describe('hooks', () => {
  it('reads a hook folder as one hook, and the hooks file inside it as one of its files (#1787)', async () => {
    await put('hooks/hooks.yaml', 'hooks: []\n');
    await put('hooks/lint/HOOK.yaml', 'description: Lint\nevent: PreToolUse\ncommand: echo lint\n');
    await put('hooks/lint/hooks.yaml', 'hooks:\n  - id: inner\n    description: Inner\n    event: Stop\n    command: echo inner\n');

    const { resolution } = await resolveTeamHookEntries({ ...localConfig, username: 't', scope: 'user', additionalRoles: [] });

    expect(resolution.kind === 'resolved' && [resolution.entries.map((entry) => entry.name), resolution.notices.map((notice) => notice.message)])
      .toEqual([['lint'], [expect.stringContaining('hooks/lint/ holds HOOK.yaml, so it is one folder, and hooks.yaml in it is one of its files')]]);
  });
});

describe('mcp', () => {
  it('delivers no server from an MCP server folder, even in an active namespace', async () => {
    const server = (name: string): string => `servers:\n  - name: ${name}\n    transport: http\n    url: https://example.com/${name}/\n`;
    await put('mcp/mcp.yaml', server('shared'));
    await putMarkerAndLowerCase('mcp/github', 'MCP.yaml', server('github'));

    const resolution = await resolveEntries(mcpEntryReader, localConfig, ['github']);

    expect(resolution.kind).toBe('resolved');
    expect(resolution.kind === 'resolved' ? resolution.entries.map((entry) => entry.entry.name) : []).toEqual(['shared']);
    expect((await listEntryFiles(repo, 'mcp')).map((file) => file.relativePath)).toEqual(['mcp/mcp.yaml']);
  });
});
