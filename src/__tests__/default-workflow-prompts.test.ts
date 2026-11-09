import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { knownSecrets } from '../env-resolution.js';
import { syncScorersThenWorkflows } from '../scorers/team-sync.js';
import type { LocalConfig } from '../types.js';
import { runLocalDriver } from '../workflow/drivers/local/local-driver.js';
import { startRun } from '../workflow/engine.js';

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** What each `teamai` verb the three workflows run prints, by its first two arguments. */
const VERBS: Record<string, unknown> = {
  'import fetch-mr': {
    url: 'https://github.com/acme/app/pull/7', title: 'Retry flaky upload', description: 'Uploads to S3 fail on 503.',
    commits: 'abc12345 retry upload', diff: 'diff --git a/up.ts b/up.ts\n+retry(3)', threads: '- reviewer: why 3? -> matches the SLA',
    thread_count: 1, author: 'dev', date: '2026-09-20',
  },
  'import draft-mr': { title: 'Retry flaky upload', file: '/tmp/learning.md', tags: ['retry'], overlaps: [], repo_url: 'https://github.com/acme/app' },
  'import finish-mr': { text: 'done', exit_code: 0, learnings: [] },
  'codebase deep-enrich-plan': {
    components: [{ slug: 'Auth', responsibilities: 'Authenticate users', facts: '- AuthService.login', call_chains: 'api -> AuthService.login -> Store', deps: 'Store' }],
    architecture: { needed: true, modules: '- Auth\n- Store', edges: 'Auth -> Store', interfaces: 'Auth: 2' },
  },
  'codebase deep-enrich-write': {},
  'codebase deep-enrich-graph': { scenarios: { needed: true, architecture: '# Architecture\nAuth calls Store.', call_chains: 'api -> Auth', modules: 'Auth, Store' } },
  'codebase deep-enrich-finish': { text: 'done', exit_code: 0, complete: true, missing_components: [], missing_architecture: false },
  'import stage': { slug: 'app', stage: '/tmp/stage', updated: true, enrich: false, narrate: true, context: 'README: an upload service', head: 'abc123', finished: false },
  'import publish': { deep: false },
  'import finish-item': { deep_complete: false },
  'import finish': { text: 'done', exit_code: 0, imported: [] },
};

const Asked = z.object({ stdin: z.string() });

/** A data home and a git checkout to run a default in, with `teamai` and `claude` stand-ins alone on PATH. */
function sandbox(): { config: LocalConfig; workspace: string; asked: () => string[] } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-default-prompts-')));
  roots.push(root);
  const knowledge = path.join(root, 'knowledge');
  const workspace = path.join(root, 'workspace');
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'claude.jsonl');
  fs.mkdirSync(path.join(knowledge, 'workflows'), { recursive: true });
  fs.mkdirSync(workspace);
  fs.mkdirSync(bin);
  execFileSync('git', ['init', '-q'], { cwd: workspace });
  fs.writeFileSync(path.join(workspace, 'tracked.txt'), 'clean\n');
  execFileSync('git', ['add', 'tracked.txt'], { cwd: workspace });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial'], { cwd: workspace });
  fs.writeFileSync(path.join(bin, 'teamai'), `#!${process.execPath}
const verbs = ${JSON.stringify(VERBS)};
const verb = process.argv.slice(2, 4).join(' ');
if (!(verb in verbs)) { process.stderr.write('fake teamai: ' + verb + '\\n'); process.exit(1); }
process.stdout.write(JSON.stringify(verbs[verb]));
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
const fs = require('fs');
let stdin = ''; process.stdin.on('data', (d) => stdin += d); process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ stdin }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'reply', usage: { input_tokens: 1, output_tokens: 1 } }));
});
`, { mode: 0o755 });
  fs.symlinkSync(execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim(), path.join(bin, 'git'));
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  vi.stubEnv('PATH', `${bin}:/bin:/usr/bin`);
  vi.stubEnv('TEAMAI_AI_TOOL', '');
  const config: LocalConfig = {
    repo: { localPath: knowledge, remote: 'local', kind: 'self' },
    username: 'tester',
    scope: 'project',
    additionalRoles: [],
    projectRoot: workspace,
    dataHome: path.join(root, 'data'),
    workflows: { tools: { default: 'claude' } },
  };
  const asked = (): string[] => fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => Asked.parse(JSON.parse(line)).stdin);

  return { config, workspace, asked };
}

/** The text the tool was given for each answer step of the default `name` run with `inputs`, in the order it ran them. */
async function answersOf(name: string, inputs: Record<string, unknown>): Promise<string[]> {
  const { config, workspace, asked } = sandbox();
  await syncScorersThenWorkflows(config);
  const started = await startRun(config, name, inputs, { secrets: await knownSecrets(config) });

  if ('error' in started) throw new Error(started.error.message);
  const done = await runLocalDriver(config, String(started.data.run), workspace);

  if ('error' in done) throw new Error(done.error.message);
  expect(done).toMatchObject({ data: { done: { outcome: 'succeeded' } } });

  return asked();
}

const golden = (name: string, file: string): string => `./fixtures/default-workflow-prompts/${name}/${file}`;

describe('the texts teamai\'s default workflows give the tool', () => {
  it.each(['en', 'zh'])('teamai-import-from-mr in %s', async (language) => {
    const [draft, ...rest] = await answersOf('teamai-import-from-mr', {
      mrs: ['https://github.com/acme/app/pull/7'], all: true, publish: false, output: false, discussions: true, language,
    });

    expect(rest).toEqual([]);
    await expect(draft).toMatchFileSnapshot(golden('teamai-import-from-mr', `draft.${language}.txt`));
  });

  it('teamai-codebase-deep-enrich', async () => {
    const [component, architecture, scenarios, ...rest] = await answersOf('teamai-codebase-deep-enrich', {
      wiki_root: path.join(os.tmpdir(), 'teamai-default-prompts-wiki'), project: 'app', max_modules: 0, concurrency: 1,
    });

    expect(rest).toEqual([]);
    await expect(component).toMatchFileSnapshot(golden('teamai-codebase-deep-enrich', 'component.txt'));
    await expect(architecture).toMatchFileSnapshot(golden('teamai-codebase-deep-enrich', 'architecture.txt'));
    await expect(scenarios).toMatchFileSnapshot(golden('teamai-codebase-deep-enrich', 'scenarios.txt'));
  });

  it('teamai-import-from-repo', async () => {
    const [narrative, ...rest] = await answersOf('teamai-import-from-repo', {
      wiki_root: path.join(os.tmpdir(), 'teamai-default-prompts-wiki'), mode: 'dir',
      items: [{ kind: 'dir', source: '/tmp/app', domain: '', auth: '', slug: '', repo_url: '', mr_urls: [] }],
      settings: { depth: 1, ssh: false, incremental: false, skip_enrich: true, max_files: 0, team_repo: '' },
      skipped: 0, concurrency: 1,
    });

    expect(rest).toEqual([]);
    await expect(narrative).toMatchFileSnapshot(golden('teamai-import-from-repo', 'narrative.txt'));
  });
});
