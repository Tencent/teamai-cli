import { parse } from 'yaml';
import type { PrCreateOptions } from '../types.js';
import { CNB_HOST, cnbExec } from './cnb-cli.js';

interface Repository { path?: string; web_url?: string }
interface Pull { number: string; state: string; head: { ref: string; repo?: Repository }; base: { ref: string; repo?: Repository } }
function matches(pull: Pull, opts: PrCreateOptions): boolean {
  const ref = (value: string): string => value.replace(/^refs\/heads\//, '');
  const repoMatches = (repo: Repository | undefined): boolean => {
    if (repo?.web_url) {
      const url = new URL(repo.web_url);
      return url.host === CNB_HOST && url.pathname.replace(/^\/|\/$/g, '') === opts.repo;
    }
    return !repo?.path || repo.path === opts.repo || repo.path === opts.repo.split('/').at(-1);
  };
  return pull.state === 'open' && ref(pull.head.ref) === opts.source && ref(pull.base.ref) === opts.target
    && repoMatches(pull.head.repo) && repoMatches(pull.base.repo);
}
function request(command: string, args: string[], opts: PrCreateOptions): unknown {
  const response = cnbExec(['pulls', command, '--repo', opts.repo, ...args], { cwd: opts.cwd, timeoutMs: opts.spawnTimeoutMs ?? 30_000 });
  if (response.status !== 0) throw new Error('CNB PR lookup failed. Check cnb authentication or CNB_TOKEN and repository access.');
  try { return parse(response.stdout) as unknown; }
  catch { throw new Error('CNB PR lookup returned invalid data. Inspect cnb before retrying.'); }
}
export async function findCnbPull(opts: PrCreateOptions): Promise<string | undefined> {
  for (let page = 1; page <= 20; page += 1) {
    const pulls = request('list-pulls', ['--state', 'open', '--base-ref', opts.target, '--page-size', '100', '--page', String(page)], opts) as Pull[];
    if (!Array.isArray(pulls)) throw new Error('CNB PR lookup returned no request list. Inspect cnb before retrying.');
    const found = pulls.find((pull) => matches(pull, opts));
    if (found) return `https://${CNB_HOST}/${opts.repo}/-/pulls/${found.number}`;
    if (pulls.length < 100) return undefined;
  }
  throw new Error('Too many open CNB requests to establish whether this branch already has one. Inspect it manually.');
}
export async function validateCnbPull(value: string, opts: PrCreateOptions): Promise<boolean | undefined> {
  const url = new URL(value);
  if (url.host !== CNB_HOST) return undefined;
  const prefix = `/${opts.repo}/-/pulls/`;
  if (!url.pathname.startsWith(prefix) || !/^\d+\/?$/.test(url.pathname.slice(prefix.length))) return false;
  return matches(request('get-pull', ['--number', url.pathname.slice(prefix.length).replace(/\/$/, '')], opts) as Pull, opts);
}
