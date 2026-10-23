/** PR delivery is resumable I/O, separate from the agent lease and never under the run lock. */
import path from 'node:path';
import type { LocalConfig } from '../types.js';
import type { GitProvider, PrCreateOptions } from '../providers/types.js';
import { getProvider, getProviderFromUrl } from '../providers/registry.js';
import { acquireLock, releaseLock } from '../update.js';
import { fail, succeed, type StepState } from './step-state.js';
import { readRun, runLockPath } from './store.js';
import { withRun, ok } from './engine.js';
import { sanitizePrUrl } from './pr-url.js';
import { AGENT_PATHS, git } from './worktree.js';
import type { StepChanges } from './workspace.js';
import type { RunState } from './types.js';
import { publishRunRecords, queueRunRecord } from './records.js';

/** Changes in earlier passes remain candidates for a stacked target. */
function allChanges(run: RunState): StepChanges[] {
  return [
    ...run.steps.flatMap((step) => [...(step.passes ?? []).flatMap((pass) => pass.changes ?? []), ...('changes' in step && step.changes ? [step.changes] : [])]),
    ...(run.archive ?? []).flatMap((pass) => pass.changes ?? []),
  ];
}

/** Follows the actual copy origin, including after-item precedence, through branches that did not deliver. */
export function deliveryTarget(run: RunState, branch: string): string | undefined {
  const changes = allChanges(run);
  const visited = new Set([branch]);
  let origin = run.copies?.[branch]?.origin;
  while (origin && !visited.has(origin)) {
    visited.add(origin);
    if (changes.some((item) => item.branch === origin && item.pr_url)) return origin;
    origin = run.copies?.[origin]?.origin;
  }
  return run.base?.ref;
}

const CI_PATHS = ['.github/workflows', '.github/actions', '.gitlab-ci.yml', '.gitlab', '.coding-ci.yaml', '.cnb', '.circleci', '.buildkite', '.husky', 'Jenkinsfile', 'azure-pipelines.yml', 'bitbucket-pipelines.yml'];

export function protectedDeliveryPaths(files: string[]): string[] {
  const roots = [...AGENT_PATHS, ...CI_PATHS].map((root) => root.toLowerCase());
  return files.filter((file) => {
    const lower = file.toLowerCase();
    return /(^|\/)(agents|claude)\.md$/.test(lower)
      || roots.some((root) => lower === root || lower.startsWith(`${root}/`));
  });
}

async function providerFor(run: RunState): Promise<{ provider: GitProvider; opts: PrCreateOptions }> {
  if (!run.checkout) throw new Error('The run has no product checkout. Resume from a checkout that can access the delivered branch.');
  // Read the configured URL: `remote get-url` expands insteadOf transport rewrites and can hide the hosting provider.
  const remote = await git(run.checkout, ['config', '--get', 'remote.origin.url']);
  if (remote.code !== 0) throw new Error('The product checkout has no origin remote. Configure origin before resuming.');
  const url = remote.stdout.trim();
  let hostingUrl = url;
  if (/^(https?|ssh):\/\//.test(url)) {
    const parsed = new URL(url);
    parsed.username = ''; parsed.password = ''; parsed.search = ''; parsed.hash = '';
    hostingUrl = parsed.protocol === 'ssh:' ? `https://${parsed.hostname}${parsed.pathname}` : parsed.toString();
  } else {
    const scp = /^[^@\s]+@([^:\s]+):(.+)$/.exec(url);
    if (scp) hostingUrl = `https://${scp[1]}/${scp[2]}`;
  }
  // Filesystem remotes are transport-only too; the registry's bare owner/repo fallback is for user input.
  const provider = /^(https?:\/\/|ssh:\/\/|[^@\s]+@[^:\s]+:)/.test(url) ? getProviderFromUrl(hostingUrl) : getProvider('git');
  const repo = provider.name === 'git' ? hostingUrl : (() => {
    const parsed = provider.parseRepoInput(hostingUrl);
    return `${parsed.owner}/${parsed.repo}`;
  })();
  return { provider, opts: { repo, source: '', target: '', title: '', cwd: run.checkout, spawnTimeoutMs: 30_000 } };
}

/** Report validation never echoes a rejected value, including a provider's error response. */
export async function validateReportedPr(run: RunState, changes: StepChanges): Promise<{ url?: string; reason?: string }> {
  const clean = sanitizePrUrl(changes.pr_url);
  if (!clean.url) return clean;
  if (!run.checkout) return clean;
  try {
    const { provider, opts } = await providerFor(run);
    const target = deliveryTarget(run, changes.branch);
    if (!target) return { reason: 'run base has no branch' };
    const valid = await provider.validatePullRequest?.(clean.url, { ...opts, source: changes.branch, target });
    return valid === false ? { reason: 'repository or branches do not match the lease' } : clean;
  } catch {
    return { reason: 'provider metadata could not be validated' };
  }
}

async function createDelivery(config: LocalConfig, run: RunState, state: Extract<StepState, { status: 'delivering' }>): Promise<string> {
  const remaining = (): number => {
    const ms = state.deliveryDeadline === undefined ? 30_000 : Math.min(30_000, state.deliveryDeadline - Date.now());
    if (ms <= 0) throw new Error('The execution deadline expired before delivery completed.');
    return ms;
  };
  remaining();
  const changes = state.changes;
  if (!changes || !run.base || !run.checkout) throw new Error('Delivery needs a writable branch, a run base, and its product checkout.');
  const target = deliveryTarget(run, changes.branch);
  if (!target) throw new Error('Run base has no branch. Start the run from a named branch (CI checkout ref: main).');
  if (![changes.to, run.base.commit].every((commit) => /^[0-9a-f]{40,64}$/i.test(commit))) throw new Error('Delivery requires full commit object ids.');
  // Do not inspect a later branch head or trust a driver's claimed list of commits.
  let head = await git(run.checkout, ['rev-parse', '--verify', `refs/heads/${changes.branch}^{commit}`]);
  if (head.code !== 0 || head.stdout.trim() !== changes.to) {
    const fetched = await git(run.checkout, ['fetch', '--no-tags', 'origin', `refs/heads/${changes.branch}`]);
    head = await git(run.checkout, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}']);
    if (fetched.code !== 0 || head.code !== 0 || head.stdout.trim() !== changes.to) throw new Error('The reported branch head is not available. Push the reported commit before resuming.');
  }
  const diff = await git(run.checkout, ['diff', '--no-renames', '--name-only', '-z', run.base.commit, changes.to, '--']);
  if (diff.code !== 0) throw new Error('Cannot inspect the delivered diff against the run base. Fetch the base commit before resuming.');
  const protectedPaths = protectedDeliveryPaths(diff.stdout.split('\0').filter(Boolean));
  if (protectedPaths.length) throw new Error(`Protected paths changed against the run base: ${protectedPaths.join(', ')}`);
  const { provider, opts } = await providerFor(run);
  opts.spawnTimeoutMs = remaining();
  if (changes.pr_url) return changes.pr_url;
  const request: PrCreateOptions = { ...opts, source: changes.branch, target,
    title: `${run.name}: ${state.id}`, description: `Workflow ${run.name}, run ${run.id}, step ${state.id}.\n\nBase: ${run.base.commit}\n\nCreated for human review. TeamAI never merges this request.` };
  const existing = await provider.findOpenPullRequest?.(request);
  let url = existing;
  if (!url) {
    const latest = await readRun(config, run.id);
    const active = typeof latest !== 'string' && latest.steps.find((step) => step.id === state.id);
    if (typeof latest === 'string' || latest.status !== 'running' || !active || active.status !== 'delivering'
      || active.pass !== state.pass || active.attempt !== state.attempt || active.settledAt !== state.settledAt) {
      throw new Error('Delivery was cancelled or replaced during PR lookup; no PR was created.');
    }
    request.spawnTimeoutMs = remaining();
    try { url = await provider.createPullRequest(request); }
    catch (error) {
      // A provider's response body or CLI output may contain credentials. Keep its established transport-only
      // fallback, but never persist arbitrary creation errors from authenticated providers.
      if (provider.name === 'git') throw error;
      throw new Error(`The ${provider.name} provider could not create the PR. Check its configured credentials, repository/branch access and push permissions, then retry delivery.`);
    }
  }
  const clean = sanitizePrUrl(url);
  if (!clean.url) throw new Error('Provider returned an unsafe PR URL. The branch is preserved; inspect the provider before retrying.');
  return clean.url;
}

/** Drains durable delivery work once. A competing delivery process leaves it for the next poll. */
export async function deliverPending(config: LocalConfig, runId: string): Promise<boolean> {
  const loaded = await readRun(config, runId);
  if (typeof loaded === 'string' || loaded.status !== 'running' || !loaded.steps.some((step) => step.status === 'delivering')) return false;
  const lock = path.join(path.dirname(runLockPath(config, runId)), `${runId}.delivery.lock`);
  if (!await acquireLock(lock)) return false;
  let changed = false;
  let queued = false;
  try {
    for (;;) {
      const run = await readRun(config, runId);
      if (typeof run === 'string' || run.status !== 'running') break;
      const state = run.steps.find((step): step is Extract<StepState, { status: 'delivering' }> => step.status === 'delivering');
      if (!state) break;
      let url: string | undefined;
      let failure: string | undefined;
      try { url = await createDelivery(config, run, state); }
      catch (error) { failure = error instanceof Error ? error.message : 'PR delivery failed'; }
      const applied = await withRun(config, runId, async (current) => {
        const step = current.steps.find((item) => item.id === state.id);
        // Cancel/retry may have invalidated this delivery while the provider was running.
        if (current.status !== 'running' || step?.status !== 'delivering' || step.pass !== state.pass || step.settledAt !== state.settledAt) {
          // An in-flight provider request cannot be revoked. Keep its safe receipt on the matching completed
          // attempt/pass, without resurrecting cancelled work, so the end record can still account for the PR.
          if (!url || !state.changes) return { save: false, envelope: ok({}) };
          const candidates = [...(step && 'changes' in step ? [step] : []), ...(step?.passes ?? []),
            ...(current.archive ?? []).filter((pass) => pass.step === state.id)];
          const receipt = candidates.find((pass) => pass.changes?.branch === state.changes!.branch && pass.changes.to === state.changes!.to
            && pass.attempt === state.attempt && (pass.pass ?? 1) === (state.pass ?? 1));
          if (!receipt?.changes) return { save: false, envelope: ok({}) };
          current.revision += 1;
          receipt.changes.pr_url = url;
          receipt.changes.prRecordedAt ??= current.revision;
          if (current.status !== 'running') queued = await queueRunRecord(config, current, current.driver, 'end') || queued;
          changed = true;
          return { save: true, envelope: ok({}) };
        }
        current.revision += 1;
        const { status: _status, ...settlement } = step;
        const expired = step.deliveryDeadline !== undefined && Date.now() >= step.deliveryDeadline;
        if (failure || expired) {
          const message = `PR delivery failed for branch ${step.changes?.branch ?? '(unknown)'}. Work is preserved. ${failure}`;
          const detail = expired ? `Execution deadline expired while delivering branch ${step.changes?.branch ?? '(unknown)'}. Work is preserved.` : message;
          fail(step, { ...settlement, settledAt: current.revision, failure: { code: expired ? 'timeout' : 'delivery_failed', message: detail }, message: detail,
            ...(url && step.changes ? { changes: { ...step.changes, pr_url: url, prRecordedAt: step.changes.prRecordedAt ?? current.revision } } : {}) });
        } else {
          succeed(step, { ...settlement, settledAt: current.revision,
            changes: { ...step.changes!, pr_url: url!, prRecordedAt: step.changes?.prRecordedAt ?? current.revision } });
        }
        changed = true;
        return { save: true, envelope: ok({}) };
      });
      if ('error' in applied) break;
    }
    return changed;
  } finally {
    await releaseLock(lock);
    if (queued) await publishRunRecords(config);
  }
}
