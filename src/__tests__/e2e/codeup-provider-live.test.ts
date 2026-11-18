import { describe, it, expect } from 'vitest';
import { CodeupProvider } from '../../providers/codeup/index.js';
import { getRepositoryNumericId, codeupFindOpenMr } from '../../providers/codeup/codeup-api.js';

/**
 * Opt-in live Codeup test. Skipped unless CODEUP_TOKEN, CODEUP_ORG_ID and
 * CODEUP_LIVE_REPO are set (CODEUP_ORG_ID is the numeric 企业标识 from
 * 云效 组织管理 → 基本信息; a PAT without platform scope cannot resolve it
 * from the user endpoint. CODEUP_LIVE_REPO is the org/group/repo path).
 *
 * Run with:
 *   CODEUP_TOKEN=xxx CODEUP_ORG_ID=xxx CODEUP_LIVE_REPO=org/group/repo \
 *     npx vitest run --config vitest.e2e.config.ts src/__tests__/e2e/codeup-provider-live.test.ts
 */
const RUN = !!process.env.CODEUP_TOKEN && !!process.env.CODEUP_ORG_ID && !!process.env.CODEUP_LIVE_REPO;
const REPO = process.env.CODEUP_LIVE_REPO!;

describe.skipIf(!RUN)('Codeup provider (live)', () => {
  it('resolves the numeric repository id from the full path', async () => {
    const id = await getRepositoryNumericId(REPO);
    expect(id).toBeGreaterThan(0);
  });

  it('findOpenMr answers with a repo URL or undefined', async () => {
    const url = await codeupFindOpenMr({
      repo: REPO,
      source: 'teamai/push/live-probe',
      target: 'master',
      timeoutMs: 15_000,
    });
    expect(typeof url === 'undefined' || url.startsWith('https://codeup.aliyun.com/')).toBe(true);
  });

  it('parseRepoInput round-trips the repo path', () => {
    const provider = new CodeupProvider();
    const info = provider.parseRepoInput(`git@codeup.aliyun.com:${REPO}.git`);
    expect(`${info.owner}/${info.repo}`).toBe(REPO);
  });
});
