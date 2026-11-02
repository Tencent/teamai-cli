/**
 * Recall in a workflow copy that runs with a team role reads an index of its own, built cold from that role's
 * knowledge, while the member's index stays the member's. Rebuilds and source updates drop the indexes that would
 * otherwise serve what their checkout no longer reads.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  detectProjectConfig: vi.fn(),
}));

vi.mock('../code-knowledge-recall.js', () => ({
  queryCodeKnowledge: vi.fn().mockResolvedValue([]),
}));

const { recall } = await import('../recall.js');
const { detectProjectConfig } = await import('../config.js');
const { dropIndexesAfterRebuild, dropIndexesAfterSourceUpdate } = await import('../utils/search-index.js');
const { managedMcpWorkspaceId } = await import('../types.js');
type LocalConfig = import('../types.js').LocalConfig;

const ROLES = `version: 1
roles:
  - id: frontend
    resources: { knowledge: [frontend], skills: [frontend], learnings: [fe-notes] }
  - id: review
    resources: { knowledge: [review], skills: [review], learnings: [rv-notes] }
`;

function learning(title: string, body: string): string {
  return `---\ntitle: "${title}"\nauthor: tester\ndate: 2026-05-01\ntags: [review]\n---\n\n${body}\n`;
}

let root: string;
let captured: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-recall-step-role-')));
  vi.stubEnv('HOME', path.join(root, 'home'));
  captured = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    captured += chunk.toString();
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

/** The member's config, and the one a copy of their checkout that runs with role `review` loads. */
function team(): { member: LocalConfig; copy: LocalConfig } {
  const repo = path.join(root, 'team-repo');
  fs.mkdirSync(path.join(repo, 'manifest'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'manifest', 'roles.yaml'), ROLES);
  for (const [dir, file, text] of [
    ['fe-notes', 'design-tokens.md', learning('Frontend design tokens', 'Use the design tokens for every colour.')],
    ['rv-notes', 'flaky-retries.md', learning('Reviewer flaky retries', 'A retry loop around a flaky assertion hides the bug zebrafish.')],
  ] as const) {
    fs.mkdirSync(path.join(repo, 'learnings', dir), { recursive: true });
    fs.writeFileSync(path.join(repo, 'learnings', dir, file), text);
  }
  const member: LocalConfig = {
    repo: { localPath: repo, remote: 'https://github.com/acme/team.git', kind: 'git' },
    username: 'member', scope: 'project', primaryRole: 'frontend', additionalRoles: [],
    projectRoot: path.join(root, 'work'), dataHome: path.join(root, 'data'),
  };
  return { member, copy: { ...member, projectRoot: path.join(root, 'work', '.teamai', 'workflow-worktrees', 'review'), stepRole: 'review' } };
}

async function recallIn(config: LocalConfig, query: string): Promise<string> {
  vi.mocked(detectProjectConfig).mockResolvedValue(config);
  captured = '';
  await recall(query, {});
  return captured;
}

describe('recall in a workflow copy that runs with a team role', () => {
  it("finds the role's learning in the copy, cold, and never in the member's checkout", async () => {
    const { member, copy } = team();

    const memberBefore = await recallIn(member, 'flaky retry zebrafish');
    const inCopy = await recallIn(copy, 'flaky retry zebrafish');
    const memberAfter = await recallIn(member, 'flaky retry zebrafish');

    expect(memberBefore).not.toContain('Reviewer flaky retries');
    expect(inCopy).toContain('Reviewer flaky retries');
    expect(memberAfter).not.toContain('Reviewer flaky retries');
    expect(fs.existsSync(path.join(root, 'data', 'search-index.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'data', 'workspaces', managedMcpWorkspaceId(copy.projectRoot ?? ''), 'search-index.json'))).toBe(true);
  });
});

describe('the indexes a rebuild or a source update drops', () => {
  /** The shared index, a role copy's, and a self-mode checkout's, each on disk. */
  function indexes(): { shared: string; roleCopy: string; other: string } {
    const write = (relative: string): string => {
      const file = path.join(root, 'data', relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '{}');
      return file;
    };
    const { copy } = team();
    return {
      shared: write('search-index.json'),
      roleCopy: write(path.join('workspaces', managedMcpWorkspaceId(copy.projectRoot ?? ''), 'search-index.json')),
      other: write(path.join('workspaces', 'another-checkout', 'search-index.json')),
    };
  }
  const left = (files: Record<string, string>): string[] => Object.entries(files).filter(([, file]) => fs.existsSync(file)).map(([name]) => name);

  it("drops no other index when a role copy's own is rebuilt", async () => {
    const files = indexes();

    await dropIndexesAfterRebuild(team().copy);

    expect(left(files)).toEqual(['shared', 'roleCopy', 'other']);
  });

  it("drops the role copies' indexes when the member's is rebuilt, which rebuild cold with their role", async () => {
    const files = indexes();

    await dropIndexesAfterRebuild(team().member);

    expect(left(files)).toEqual(['shared']);
  });

  it('drops every other index, the shared one included, when a source changes in a role copy', async () => {
    const files = indexes();

    await dropIndexesAfterSourceUpdate(team().copy);

    expect(left(files)).toEqual(['roleCopy']);
  });

  it("drops every other index when a source changes in the member's checkout, outside self mode too", async () => {
    const files = indexes();

    await dropIndexesAfterSourceUpdate(team().member);

    expect(left(files)).toEqual(['shared']);
  });
});
