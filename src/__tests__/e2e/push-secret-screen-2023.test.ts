/**
 * Real CLI for #2023: push refuses when the secret screen matches the selected
 * resources, `--allow-secrets` pushes past it knowingly, and the `--file` route
 * (which skips the scan pipeline) screens the file itself. The team origin must
 * stay untouched on a refusal.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { fakeGhHost, type FakeGh } from '../helpers/fake-gh.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist', 'index.js');
const TEAM_URL = 'https://github.com/acme/team.git';
const PRODUCT_URL = 'https://github.com/acme/frontend.git';

const TOKEN = 'github_pat_A1B2C3D4E5F6G7H8I9J0K1L2M3';
const LEAKY_SKILL = `---\nname: leaky\ndescription: Rotate things.\n---\n\nRotate the deploy token:\n\n    ${TOKEN}\n\nThen tell the channel.\n`;
const CLEAN_SKILL = `---\nname: tidy\ndescription: Tidy things.\n---\n\nRun the tidy step on Tuesdays.\n`;

interface Member {
  root: string;
  work: string;
  origin: string;
  teamClone: string;
  gh: FakeGh;
  env: NodeJS.ProcessEnv;
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim();
}

function write(root: string, files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
}

function seeded(root: string, name: string, files: Record<string, string>, origin: string): void {
  const seed = path.join(root, `seed-${name}`);
  write(seed, files);
  git(root, ['init', '-q', '--bare', '-b', 'main', origin]);
  git(seed, ['init', '-q', '-b', 'main']);
  git(seed, ['add', '-A']);
  git(seed, ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.com', 'commit', '-qm', 'seed']);
  git(seed, ['push', '-q', origin, 'main']);
}

function teamMember(): Member {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-secret-screen-')));
  roots.push(root);
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const gh = fakeGhHost(path.join(root, 'gh'));
  fs.symlinkSync(gh.bin, path.join(bin, 'gh'));
  fs.writeFileSync(path.join(home, '.gitconfig'), [
    '[user]', '\tname = member', '\temail = member@example.com',
    `[url "file://${path.join(root, 'team.git')}"]`, `\tinsteadOf = ${TEAM_URL}`,
    `[url "file://${path.join(root, 'app.git')}"]`, `\tinsteadOf = ${PRODUCT_URL}`, '',
  ].join('\n'));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    PATH: [bin, process.env.PATH ?? ''].join(path.delimiter), GIT_TERMINAL_PROMPT: '0', FORCE_COLOR: '0', TEAMAI_NONINTERACTIVE: '1',
  };
  for (const name of ['XDG_CONFIG_HOME', 'GITHUB_TOKEN', 'GH_TOKEN', 'CLAUDE_CODE_SESSION_ID']) delete env[name];

  const origin = path.join(root, 'team.git');
  seeded(root, 'team', {
    'teamai.yaml': `team: acme\nrepo: ${TEAM_URL}\nprovider: github\nusageReport: false\n`,
    'skills/deploy/SKILL.md': '---\nname: deploy\ndescription: Deploy the app.\n---\nRun the deploy.\n',
  }, origin);
  seeded(root, 'app', { 'README.md': '# app\n' }, path.join(root, 'app.git'));
  const work = path.join(root, 'home', 'work');
  git(root, ['clone', '-q', PRODUCT_URL, work], env);
  const clone = path.join(work, '.teamai', 'team-repo');
  git(root, ['clone', '-q', TEAM_URL, clone], env);
  write(work, {
    '.teamai/config.yaml': YAML.stringify({
      repo: { localPath: clone, remote: TEAM_URL, kind: 'git' },
      username: 'member', scope: 'project', projectRoot: work, updatePolicy: 'skip', additionalRoles: [], enabledAgents: ['claude'],
    }),
    '.claude/skills/leaky/SKILL.md': LEAKY_SKILL,
    '.claude/skills/tidy/SKILL.md': CLEAN_SKILL,
  });
  const pulled = teamai({ work, env }, ['pull']);
  expect(pulled.code, pulled.output).toBe(0);
  const projects = path.join(root, 'home', '.teamai', 'projects');
  const [dataHome] = fs.readdirSync(projects).map((name) => path.join(projects, name));
  if (dataHome === undefined) throw new Error(`no workspace data home under ${projects}`);

  return { root, work, origin, teamClone: path.join(dataHome, 'team-repo'), gh, env };
}

function teamai(member: Pick<Member, 'work' | 'env'>, args: string[]): { code: number | null; output: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: member.work, env: member.env, encoding: 'utf8', timeout: 60_000 });
  if (result.error) throw result.error;
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

function proposed(member: Member): string[] {
  const pushed = git(member.origin, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/teamai/push/']).split('\n').filter(Boolean);

  return pushed.flatMap((branch) => git(member.origin, ['diff', '--name-only', 'main', branch]).split('\n').filter(Boolean));
}

describe('the push secret screen (#2023)', () => {
  it('refuses a skill whose file carries a token, leaving the origin untouched', async () => {
    const member = teamMember();

    const pushed = teamai(member, ['push', '--skill', '.claude/skills/leaky']);

    expect(pushed.code, pushed.output).toBe(1);
    expect(pushed.output).toContain('secret shape');
    expect(pushed.output).toContain('gh_pat');
    expect(pushed.output).toContain('leaky/SKILL.md');
    expect(pushed.output).toContain('--allow-secrets');
    expect(proposed(member)).toEqual([]);
  });

  it('pushes the same skill past the screen with --allow-secrets', async () => {
    const member = teamMember();

    const pushed = teamai(member, ['push', '--skill', '.claude/skills/leaky', '--allow-secrets']);

    expect(pushed.code, pushed.output).toBe(0);
    expect(pushed.output).toContain('Pull Request created: https://github.com/acme/team/pull/1');
    expect(proposed(member)).toContain('skills/leaky/SKILL.md');
  });

  it('does not stop a clean skill', async () => {
    const member = teamMember();

    const pushed = teamai(member, ['push', '--skill', '.claude/skills/tidy']);

    expect(pushed.code, pushed.output).toBe(0);
    expect(proposed(member)).toContain('skills/tidy/SKILL.md');
  });

  it('warns on a key=value docs placeholder but pushes it', async () => {
    const member = teamMember();
    const skillDir = path.join(member.work, '.claude', 'skills', 'docsy');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: docsy\ndescription: Docs.\n---\n\nUse `token: example-abcdef-123456` as the placeholder value.\n');

    const pushed = teamai(member, ['push', '--skill', '.claude/skills/docsy']);

    expect(pushed.code, pushed.output).toBe(0);
    expect(pushed.output).toContain('possible secret');
    expect(proposed(member)).toContain('skills/docsy/SKILL.md');
  });

  it('refuses a config-only push whose teamai.yaml carries a token (#2071 review)', async () => {
    const member = teamMember();
    const configPath = path.join(member.teamClone, 'teamai.yaml');
    fs.appendFileSync(configPath, `# rotation token for scripts: ${TOKEN}\n`);

    const refused = teamai(member, ['push']);

    expect(refused.code, refused.output).toBe(1);
    expect(refused.output).toContain('secret shape');
    expect(refused.output).toContain('gh_pat');
    expect(refused.output).toContain('--allow-secrets');
    expect(proposed(member)).toEqual([]);
  });

  it('refuses a --file payload that carries a token, then pushes it with --allow-secrets', async () => {
    const member = teamMember();
    const file = path.join(member.root, 'tokens.md');
    fs.writeFileSync(file, `# Notes\n\nThe rotation token is ${TOKEN}.\n`);

    const refused = teamai(member, ['push', '--file', file, '--path', 'skills/deploy/notes/tokens.md']);

    expect(refused.code, refused.output).toBe(1);
    expect(refused.output).toContain('secret screen');
    expect(refused.output).toContain('gh_pat');
    expect(refused.output).toContain('--allow-secrets');
    expect(proposed(member)).toEqual([]);

    const allowed = teamai(member, ['push', '--file', file, '--path', 'skills/deploy/notes/tokens.md', '--allow-secrets']);

    expect(allowed.code, allowed.output).toBe(0);
    // The report prints even when --allow-secrets overrides the refusal.
    expect(allowed.output).toContain('matches the secret screen');
    expect(allowed.output).toContain('--allow-secrets');
    expect(proposed(member)).toEqual(['skills/deploy/notes/tokens.md']);
  });
});
