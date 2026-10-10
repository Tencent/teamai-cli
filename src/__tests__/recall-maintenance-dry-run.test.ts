import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCommandTable } from './helpers/command-table.js';

// `recall maintenance` and `recall promote` declare their own `--dry-run`, but
// the root program declares one too, and Commander gives it to the root
// wherever it appears. These actions read only their own options, so a preview
// pruned, drafted and promoted for real (#900). They are driven through the
// real command table here, because that is where the flag went missing.
vi.mock('../migrate.js', () => ({
  maybeMigrate: vi.fn(async () => undefined),
  queueKeptInCheckout: vi.fn(async () => null),
}));
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  autoDetectInit: vi.fn(async () => ({
    localConfig: { repo: { localPath: '/team-repo', remote: 'owner/repo' }, username: 'dev' },
    teamConfig: { team: 'demo', repo: 'owner/repo' },
  })),
}));
const candidate = { filename: 'l.md', path: '/l.md', confidence: 0.05, lastActivity: '', reason: 'low', docId: 'l' };
vi.mock('../maintenance/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../maintenance/index.js')>()),
  resolveMaintenancePaths: vi.fn(async () => ({
    repoPath: '/team-repo', votesDir: '/votes', learningsWriteDir: '/learnings', learningsReadDirs: ['/learnings'],
  })),
  findPruneCandidates: vi.fn(async () => [candidate]),
  executePrune: vi.fn(async (_dir: string, _c: unknown, o: { dryRun?: boolean }) =>
    (o.dryRun ? { archived: 0, removed: 0, changed: [] } : { archived: 0, removed: 1, changed: ['/l.md'] })),
  computeAllConfidence: vi.fn(async () => new Map([['l', 0.9]])),
  writeBackConfidence: vi.fn(async () => ['/learnings/l.md']),
  findStaleEntries: vi.fn(async () => [{ path: '/team-repo/docs/a.md' }]),
  reportStaleEntries: vi.fn(),
  findRelatedAdoptedLearnings: vi.fn(async () => []),
  generateUpdateDraft: vi.fn(async () => null),
  findPromotionCandidates: vi.fn(async () => [{ ...candidate, suggestedCategory: 'docs' }]),
  executePromotion: vi.fn(async (_c: unknown, _r: string, o: { dryRun?: boolean }) =>
    ({ targetPath: '/team-repo/docs/l.md', marked: o.dryRun ? null : '/learnings/l.md' })),
}));
vi.mock('../utils/learnings-publish.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/learnings-publish.js')>()),
  publishLearningsMaintenance: vi.fn(async () => ({ status: 'published' })),
}));
vi.mock('../utils/logger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/logger.js')>()),
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
}));

beforeEach(() => {
  vi.stubEnv('TEAMAI_COMMAND_TABLE_ONLY', '1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.clearAllMocks();
});

async function run(args: string[]): Promise<void> {
  const program = await loadCommandTable();
  await program.parseAsync(['node', 'teamai', ...args]);
}

async function mocks() {
  return {
    ...(await import('../maintenance/index.js')),
    ...(await import('../utils/learnings-publish.js')),
    ...(await import('../config.js')),
  };
}

const PREVIEWS: Array<[string, string[]]> = [
  ['recall maintenance --prune --dry-run', ['recall', 'maintenance', '--prune', '--dry-run']],
  ['--dry-run recall maintenance --prune', ['--dry-run', 'recall', 'maintenance', '--prune']],
  ['recall maintenance --confidence-writeback --dry-run', ['recall', 'maintenance', '--confidence-writeback', '--dry-run']],
  ['recall maintenance --update-quality --dry-run', ['recall', 'maintenance', '--update-quality', '--dry-run']],
  ['recall promote <id> --dry-run', ['recall', 'promote', 'l', '--dry-run']],
];

describe('recall maintenance and recall promote under --dry-run (#900)', () => {
  it.each(PREVIEWS)('%s loads, changes and publishes nothing', async (_label, args) => {
    await run(args);
    const m = await mocks();
    expect(m.autoDetectInit).toHaveBeenCalledWith(undefined, { dryRun: true });
    for (const call of vi.mocked(m.executePrune).mock.calls) expect(call[2]).toMatchObject({ dryRun: true });
    for (const call of vi.mocked(m.executePromotion).mock.calls) expect(call[2]).toMatchObject({ dryRun: true });
    for (const call of vi.mocked(m.writeBackConfidence).mock.calls) expect(call[3]).toEqual({ dryRun: true });
    expect(m.generateUpdateDraft).not.toHaveBeenCalled();
    expect(m.publishLearningsMaintenance).not.toHaveBeenCalled();
  });

  // The positive control: the same commands without the flag do reach the
  // write, so the assertions above are not passing on a path that never gets there.
  it.each([
    ['recall maintenance --prune', ['recall', 'maintenance', '--prune']],
    ['recall maintenance --confidence-writeback', ['recall', 'maintenance', '--confidence-writeback']],
    ['recall promote <id>', ['recall', 'promote', 'l']],
  ])('%s still publishes without the flag', async (_label, args) => {
    await run(args);
    const m = await mocks();
    expect(m.publishLearningsMaintenance).toHaveBeenCalledTimes(1);
  });
});
