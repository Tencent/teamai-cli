import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

import { describeDeliveryConflict, resolveDesiredAgents } from '../resources/desired.js';
import type { LocalConfig, TeamaiConfig } from '../types.js';

/** The names of the agents pull delivers, failing the test on a namespace collision. */
async function delivered(teamConfig: TeamaiConfig, localConfig: LocalConfig): Promise<string[]> {
  const result = await resolveDesiredAgents(teamConfig, localConfig, null);
  if (result.kind === 'conflict') throw new Error(`unexpected collision: ${describeDeliveryConflict(result)}`);
  return result.items.map((item) => item.name).sort();
}

describe('resolveDesiredAgents', () => {
  let tempDir: string;
  let localConfig: LocalConfig;

  function team(recall: boolean): TeamaiConfig {
    return {
      team: 'test',
      description: '',
      repo: 'owner/repo',
      provider: 'github',
      reviewers: [],
      sharing: {
        skills: {}, rules: { enforced: [] }, docs: { localDir: '' }, env: { injectShellProfile: true }, recall: { enabled: recall },
      },
      toolPaths: { claude: { agents: '.claude/agents' } },
    };
  }

  beforeEach(async () => {
    tempDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-desired-agents-'));
    vi.stubEnv('HOME', path.join(tempDir, 'home'));
    vi.stubEnv('TEAMAI_RECALL_DISABLED', '');
    const repoPath = path.join(tempDir, 'team-repo');
    await fse.outputFile(path.join(repoPath, 'agents', 'teamai-recall.md'), '---\nname: teamai-recall\ndescription: Team recall\n---\n');
    await fse.outputFile(path.join(repoPath, 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Reviews\n---\n');
    localConfig = { repo: { localPath: repoPath, remote: 'owner/repo' }, username: 'tester', scope: 'user', additionalRoles: [] };
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tempDir);
  });

  it('delivers the team teamai-recall while recall is on', async () => {
    expect(await delivered(team(true), localConfig)).toEqual(['reviewer', 'teamai-recall']);
  });

  it('delivers no team teamai-recall while recall is off, as recall off removes it', async () => {
    expect(await delivered(team(false), localConfig)).toEqual(['reviewer']);
  });
});
