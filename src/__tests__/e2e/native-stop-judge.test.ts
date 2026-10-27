import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { expect, it } from 'vitest';
import { AGENT_SESSION_ENV } from '../../utils/session-id.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../dist/index.js');
it('judges a native Codex Stop without a Claude transcript and credits the recalled doc once', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-native-judge-'));
  const home = path.join(root, 'home');
  const seed = path.join(root, 'seed');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(path.join(seed, 'learnings'), { recursive: true });
  fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
  fs.mkdirSync(bin);
  const prompts = path.join(root, 'judge-prompts.jsonl');
  // Only the model boundary is replaced: recall, dispatch, grounding and votes
  // all run through the built CLI against the scratch team and HOME.
  const fake = path.join(bin, 'claude');
  // Answers as `claude -p --output-format json` does: the prompt on stdin, the reply in a result record.
  fs.writeFileSync(fake, `#!${process.execPath}\nconst fs=require('node:fs'); const prompt=fs.readFileSync(0,'utf8'); fs.appendFileSync(${JSON.stringify(prompts)},JSON.stringify(prompt)+'\\n'); console.log(JSON.stringify({type:'result',result:'["retry"]'}));\n`);
  fs.chmodSync(fake, 0o755);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home,
    PATH: `${bin}:/usr/bin:/bin`, XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test',
    FORCE_COLOR: '0', TEAMAI_UPVOTE_JUDGE: '1', TEAMAI_RECALL_DISABLED: '', TEAMAI_CONTRIBUTE_HINT_DISABLED: '1' };
  for (const key of AGENT_SESSION_ENV) delete env[key];
  env.CODEX_SESSION_ID = 'native-judge-fixture';
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, stdio: 'pipe' });
  const cli = (args: string[], input?: string) => execFileSync(process.execPath, [CLI, ...args], { cwd: root, env, encoding: 'utf8', input, timeout: 45000, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    fs.writeFileSync(path.join(seed, 'teamai.yaml'), 'team: Judge fixture\nrepo: fixture/team\nprovider: git\n');
    fs.writeFileSync(path.join(seed, 'learnings/retry.md'), '---\ntitle: Retry failed requests\ntags: [retry, requests]\n---\nRetry failed requests with exponential backoff.\n');
    git(seed, 'init', '-q', '-b', 'main'); git(seed, 'add', '.'); git(seed, 'commit', '-qm', 'fixture');
    const origin = path.join(root, 'origin.git');
    git(root, 'clone', '-q', '--bare', seed, origin);
    const repo = path.join(home, '.teamai/team-repo');
    git(root, 'clone', '-q', origin, repo);
    fs.writeFileSync(path.join(home, '.teamai/config.yaml'), YAML.stringify({ repo: { localPath: repo, remote: origin, kind: 'git' }, username: 'fixture', scope: 'user', updatePolicy: 'skip', usageReportEnabled: false, enabledAgents: ['joycode'], additionalRoles: [] }));
    cli(['pull', '--force']);
    expect(cli(['recall', 'retry failed requests'])).toContain('retry.md');
    const stdin = JSON.stringify({ cwd: root, session_id: 'native-judge-fixture', last_assistant_message: 'I retried the failed requests with exponential backoff.' });
    cli(['hook-dispatch', 'stop', '--tool', 'codex', '--bg-only'], stdin);
    const file = path.join(home, '.teamai/user-votes/fixture.yaml');
    const votes = () => YAML.parse(fs.readFileSync(file, 'utf8')).votes.retry.upvoted_count;
    expect(votes()).toBe(1);
    expect(fs.readFileSync(prompts, 'utf8')).toContain('I retried the failed requests');
    cli(['hook-dispatch', 'stop', '--tool', 'codex', '--bg-only'], stdin);
    expect(votes()).toBe(1);
    expect(fs.readFileSync(prompts, 'utf8').trim().split('\n')).toHaveLength(1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 120000);
