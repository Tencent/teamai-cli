import '../helpers/isolate-home.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { GiteaProvider } from '../../providers/gitea/index.js';
import { giteaJson, redactGiteaOutput } from '../../providers/gitea/gitea-api.js';
import { giteaRepoPath, parseGiteaRepoInput } from '../../providers/gitea/repo-url.js';
import { shallowClone, shallowFetch } from '../../clone.js';

/**
 * Opt-in provider integration, using dedicated test accounts/repositories only.
 *
 * Required: TEAMAI_GITEA_LIVE=1, GITEA_URL, GITEA_TOKEN (author),
 * TEAMAI_GITEA_TEST_REPO=org/teamai-test, TEAMAI_GITEA_TEST_REVIEWER,
 * TEAMAI_GITEA_REVIEWER_TOKEN. Optional PUBLIC_URL / SSH_URL below enable
 * anonymous/SSH cases. The write test merges a synthetic file into the fixture.
 * This tests the provider API; it does not replace a real built-CLI run.
 */
const RUN = process.env.TEAMAI_GITEA_LIVE === '1' && !!process.env.GITEA_URL && !!process.env.GITEA_TOKEN
  && !!process.env.TEAMAI_GITEA_TEST_REPO && !!process.env.TEAMAI_GITEA_TEST_REVIEWER && !!process.env.TEAMAI_GITEA_REVIEWER_TOKEN;
const publicUrl = process.env.TEAMAI_GITEA_PUBLIC_URL;
const sshUrl = process.env.TEAMAI_GITEA_SSH_URL;

describe.skipIf(!RUN)('Gitea provider (dedicated live fixture)', () => {
  const provider = new GiteaProvider();
  const runId = randomUUID().slice(0, 8);
  const branch = `teamai-live-${runId}`;
  let directory: string;
  let clone: string;
  let route: string;
  let prNumber: number | undefined;
  let pushed = false;

  function git(...args: string[]): string {
    const result = spawnSync('git', args, { cwd: clone, encoding: 'utf8', timeout: 45_000, windowsHide: true });
    if (result.status !== 0) throw new Error(redactGiteaOutput(`Fixture git ${args[0]} failed: ${result.stderr ?? result.error?.message ?? ''}`));
    return result.stdout.trim();
  }

  beforeAll(async () => {
    vi.stubEnv('GIT_TERMINAL_PROMPT', '0');
    vi.stubEnv('GIT_ASKPASS', 'echo');
    vi.stubEnv('GCM_INTERACTIVE', 'never');
    const repo = process.env.TEAMAI_GITEA_TEST_REPO!;
    const info = parseGiteaRepoInput(repo);
    if (!info.repo.startsWith('teamai-')) throw new Error('Use a dedicated teamai-* fixture repository.');
    route = giteaRepoPath(repo);
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gitea-provider-live-'));
    clone = path.join(directory, 'team');
    await provider.authenticate();
    provider.cloneRepo(info.httpsUrl, clone);
    git('config', 'user.name', 'TeamAI integration fixture');
    git('config', 'user.email', 'teamai-fixture@example.test');
  });

  afterAll(async () => {
    // Only this run's feature ref is removed. The merged fixture file is kept
    // as evidence, and no default branch, repository or account is deleted.
    if (prNumber) {
      try {
        const current = await giteaJson<{ state: string }>(`${route}/pulls/${prNumber}`);
        if (current.state === 'open') await giteaJson(`${route}/pulls/${prNumber}`, { method: 'PATCH', body: { state: 'closed' } });
      } catch { console.warn(`Fixture PR ${prNumber} needs manual cleanup.`); }
    }
    if (pushed) {
      try { await giteaJson(`${route}/branches/${encodeURIComponent(branch)}`, { method: 'DELETE' }); }
      catch { console.warn(`Fixture branch ${branch} needs manual cleanup.`); }
    }
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('creates and recovers a reviewed PR, updates its branch, merges and reads evidence', { timeout: 120_000, retry: 0 }, async () => {
    const metadata = await giteaJson<{ default_branch: string }>(route);
    const reviewer = process.env.TEAMAI_GITEA_TEST_REVIEWER!;
    const reviewerToken = process.env.TEAMAI_GITEA_REVIEWER_TOKEN!;
    const filename = `gitea-provider-${runId}.txt`;
    git('checkout', '-b', branch);
    fs.writeFileSync(path.join(clone, filename), 'Synthetic provider integration evidence.\n');
    git('add', filename);
    git('commit', '-m', `test: Gitea provider fixture ${runId}`);
    git('push', 'origin', branch);
    pushed = true;
    const options = { repo: process.env.TEAMAI_GITEA_TEST_REPO!, source: branch, target: metadata.default_branch,
      title: `Gitea provider integration ${runId}`, reviewers: [reviewer] };
    const url = await provider.createPullRequest(options);
    prNumber = Number(url.match(/\/pulls\/(\d+)$/)?.[1]);
    expect(prNumber).toBeGreaterThan(0);
    expect(await provider.createPullRequest(options)).toBe(url);
    const pull = await giteaJson<{ requested_reviewers: Array<{ login: string }> }>(`${route}/pulls/${prNumber}`);
    expect(pull.requested_reviewers.map((item) => item.login)).toContain(reviewer);
    fs.appendFileSync(path.join(clone, filename), 'Second revision follows the same branch.\n');
    git('add', filename);
    git('commit', '-m', `test: update Gitea fixture ${runId}`);
    git('push', 'origin', branch);
    const updated = await giteaJson<{ head: { sha: string } }>(`${route}/pulls/${prNumber}`);
    expect(updated.head.sha).toBe(git('rev-parse', 'HEAD'));
    await giteaJson(`${route}/issues/${prNumber}/comments`, { method: 'POST', token: reviewerToken,
      body: { body: `Conversation evidence ${runId}` } });
    await giteaJson(`${route}/pulls/${prNumber}/reviews`, { method: 'POST', token: reviewerToken, body: {
      event: 'APPROVED', body: `Review decision ${runId}`,
      comments: [{ path: filename, body: `Inline evidence ${runId}`, new_position: 1 }],
    } });
    await giteaJson(`${route}/pulls/${prNumber}/merge`, { method: 'POST', token: reviewerToken, body: { do: 'merge' } });
    const data = await provider.fetchMergeRequest(url);
    expect(data.title).toBe(options.title);
    expect(data.mergedAt).toBeTruthy();
    expect(data.commits.length).toBeGreaterThanOrEqual(2);
    expect(data.diff).toContain(filename);
    const discussionBodies = data.discussions?.flatMap(thread => thread.notes.map(note => note.body)) ?? [];
    expect(discussionBodies).toContain(`Conversation evidence ${runId}`);
    expect(discussionBodies).toContain(`Review decision ${runId}`);
    expect(discussionBodies).toContain(`Inline evidence ${runId}`);
  });

  it.skipIf(!publicUrl)('clones and incrementally fetches a public repo without credentials', async () => {
    vi.stubEnv('GITEA_TOKEN', '');
    try {
      const target = path.join(directory, 'public');
      const first = await shallowClone(publicUrl!, target, 'gitea', { forceAnonymous: true, timeoutMs: 15_000 });
      expect(first.cloneMethod).toBe('https-anonymous');
      expect((await shallowFetch(target, { provider: 'gitea', timeoutMs: 15_000 })).sha).toBe(first.sha);
    } finally { vi.unstubAllEnvs(); }
  });

  it.skipIf(!sshUrl)('retains the explicit SSH transport and port', () => {
    const target = path.join(directory, 'ssh');
    provider.cloneRepo(sshUrl!, target);
    const result = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: target, encoding: 'utf8', windowsHide: true });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(parseGiteaRepoInput(sshUrl!).httpsUrl);
  });
});
