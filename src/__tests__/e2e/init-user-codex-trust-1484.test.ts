/**
 * E2E (#1484): `init --scope user` acts on the member settings of a
 * settings-only ~/.teamai/config.yaml, not only saves them. With
 * `codexTrustEnabled: false` there, init trusts no hook in Codex.
 *
 * Runs the built CLI against a local team repo reached through a synthetic
 * HTTPS URL, with the fake `codex` on PATH. Each case gets its own HOME.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { installFakeCodex, readFakeCodexState } from '../helpers/fake-codex.js';
import { waitForDetachedChildren } from '../helpers/detached-processes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '..', '..', '..', 'dist', 'index.js');
const TEAM_URL = 'https://git.example.test/team/trust.git';
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

let sandbox: string;
let remote: string;
let fakeCodexDir: string;

beforeAll(() => {
  if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
  sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-init-user-codex-trust-')));
  fakeCodexDir = installFakeCodex({ dir: path.join(sandbox, 'bin') });
  const seed = path.join(sandbox, 'team-seed');
  fs.mkdirSync(seed);
  fs.writeFileSync(path.join(seed, 'teamai.yaml'), `team: trust\nrepo: ${TEAM_URL}\nprovider: git\nreviewers: []\n`);
  git(['init', '-q', '-b', 'main'], seed);
  git(['add', '.'], seed);
  git(['commit', '-qm', 'seed'], seed);
  remote = path.join(sandbox, 'team.git');
  git(['clone', '-q', '--bare', seed, remote], sandbox);
});

afterAll(async () => {
  await waitForDetachedChildren();
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

function git(args: string[], cwd: string, env: NodeJS.ProcessEnv = { ...process.env, ...GIT_ENV }): void {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stdout}${r.stderr}`);
}

/** A member with a HOME of its own, `machineSettings` (if any) as its settings-only config.yaml. */
function member(name: string, machineSettings?: Record<string, unknown>) {
  const home = fs.mkdtempSync(path.join(sandbox, `${name}-`));
  const codexHome = path.join(home, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  const config = path.join(home, '.teamai', 'config.yaml');
  if (machineSettings) {
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.writeFileSync(config, YAML.stringify(machineSettings));
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env, ...GIT_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1', CODEX_HOME: codexHome, FORCE_COLOR: '0',
    PATH: [fakeCodexDir, process.env.PATH ?? ''].join(path.delimiter),
  };
  delete env.GIT_CONFIG_GLOBAL;
  delete env.CLAUDE_CONFIG_DIR;
  git(['config', '--global', `url.${remote}.insteadOf`, TEAM_URL], home, env);
  const init = () => {
    const r = spawnSync(process.execPath, [CLI, 'init', TEAM_URL, '--provider', 'git', '--agent', 'codex', '--scope', 'user'], {
      cwd: home, env, encoding: 'utf8', input: '',
    });
    return { code: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const trustedHooks = () => Object.values(readFakeCodexState(codexHome).hooksState).filter((s) => s.trusted_hash).length;
  return { init, config, trustedHooks };
}

describe('init --scope user honours a settings-only machine file (#1484)', () => {
  it('trusts no Codex hook when the machine file sets codexTrustEnabled: false, and keeps its settings', () => {
    const m = member('trust-off', {
      codexTrustEnabled: false, recallEnabled: false, updatePolicy: 'skip', workflows: { max_parallel: 2 },
    });

    const run = m.init();

    expect(run.code, run.output).toBe(0);
    expect(run.output).not.toMatch(/Trusted \d+ teamai hook\(s\) in Codex/);
    expect(run.output).toContain('Codex hooks written, but Codex may require you to review/trust them');
    expect(m.trustedHooks()).toBe(0);
    expect(YAML.parse(fs.readFileSync(m.config, 'utf8'))).toMatchObject({
      codexTrustEnabled: false, recallEnabled: false, updatePolicy: 'skip', workflows: { max_parallel: 2 }, scope: 'user',
    });
  }, 120_000);

  it('trusts the Codex hooks when there is no machine file', () => {
    const m = member('no-machine-file');

    const run = m.init();

    expect(run.code, run.output).toBe(0);
    expect(run.output).toMatch(/Trusted \d+ teamai hook\(s\) in Codex/);
    expect(m.trustedHooks()).toBeGreaterThan(0);
  }, 120_000);
});
