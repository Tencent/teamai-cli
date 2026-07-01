import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// ─── Issue #85 end-to-end: remaining scope-isolation gaps ──────────────
//
// #73/#77 already fixed recall's dual-scope merge and #91 fixed auto-recall's
// upvote scope (see scope-isolation-e2e.test.ts). This file drives the real
// CLI binary against offline git fixtures to cover the four gaps that were
// still open after those landed:
//   1. `hooks inject`/`hooks remove` must track the user-home copy under the
//      USER's own manifest, not the project's (else duplicate injection /
//      wrongful cleanup of the shared tool settings file).
//   2. `tags subscribe`/`unsubscribe` must write to the active scope's
//      config.yaml, not always ~/.teamai/config.yaml.
//   3. `contribute` must make a new learning immediately recallable, without
//      requiring a separate `pull` to rebuild the index.
//   4. A project config.yaml missing `projectRoot` (pre-migration / hand
//      edited) must still resolve to the project directory rather than
//      silently degrading to the user's home.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

interface RunResult {
  code: number | null;
  output: string;
}

function runCLI(args: string[], env: Record<string, string>, cwd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      env: { ...process.env, FORCE_COLOR: '0', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { out += d.toString(); });
    child.stdin.end();
    child.on('close', (code) => resolve({ code, output: out }));
  });
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

function git(cmd: string, cwd: string): void {
  execSync(`git ${cmd}`, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } });
}

const TEAM_YAML = [
  'team: e2e-team',
  'repo: https://example.com/e2e.git',
  'provider: tgit',
  'toolPaths:',
  '  claude:',
  '    skills: .claude/skills',
  '    rules: .claude/rules',
  '    settings: .claude/settings.json',
].join('\n');

const HOOKS_YAML = [
  'hooks:',
  '  - id: e2e-marker-hook',
  '    description: e2e marker hook',
  '    event: Stop',
  '    command: echo teamai-e2e-hook-marker',
].join('\n');

/** Create a bare-ish pushable git remote fixture with teamai.yaml + hooks.yaml. */
function makeRemote(dir: string): void {
  fs.mkdirSync(path.join(dir, 'learnings'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'teamai.yaml'), TEAM_YAML);
  fs.writeFileSync(path.join(dir, 'hooks', 'hooks.yaml'), HOOKS_YAML);
  git('init -q', dir);
  // Allow `git push` to update the checked-out branch directly (contribute()
  // pushes straight to master with no separate bare remote in this fixture).
  git('config receive.denyCurrentBranch updateInstead', dir);
  git('add -A', dir);
  git('commit -q -m init', dir);
}

describe('issue #85 remaining scope-isolation gaps (e2e)', () => {
  let sandbox: string;
  let homeDir: string;
  let projectRoot: string;
  let userConfigPath: string;
  let userConfigBefore: string;

  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-issue85-e2e-'));
    homeDir = path.join(sandbox, 'home');
    projectRoot = path.join(sandbox, 'proj');
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(path.join(homeDir, '.claude', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.claude', 'skills'), { recursive: true });

    // ── User-scope fixture (present only so we can prove project-scope
    //    commands do NOT write into it, except where #44 intentionally
    //    mirrors hooks into the user's home). ──
    const userRemote = path.join(sandbox, 'user-remote');
    makeRemote(userRemote);
    const userLocal = path.join(homeDir, '.teamai', 'team-repo');
    git(`clone -q "${userRemote}" "${userLocal}"`, sandbox);
    userConfigPath = path.join(homeDir, '.teamai', 'config.yaml');
    fs.writeFileSync(
      userConfigPath,
      [
        'repo:',
        `  localPath: ${userLocal}`,
        `  remote: ${userRemote}`,
        'username: ci-user',
        'updatePolicy: auto',
        'scope: user',
      ].join('\n'),
    );
    userConfigBefore = fs.readFileSync(userConfigPath, 'utf-8');

    // ── Project-scope fixture. Deliberately omit `projectRoot:` from the
    //    on-disk config to exercise the detectProjectConfig() backfill
    //    (item 4) through every test below. ──
    const projectRemote = path.join(sandbox, 'proj-remote');
    makeRemote(projectRemote);
    const projectLocal = path.join(projectRoot, '.teamai', 'team-repo');
    git(`clone -q "${projectRemote}" "${projectLocal}"`, sandbox);
    fs.writeFileSync(
      path.join(projectRoot, '.teamai', 'config.yaml'),
      [
        'repo:',
        `  localPath: ${projectLocal}`,
        `  remote: ${projectRemote}`,
        'username: ci-proj',
        'updatePolicy: auto',
        'scope: project',
      ].join('\n'),
    );
  }, 60_000);

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  describe('projectRoot backfill (item 4)', () => {
    it('recall resolves the project scope even though config.yaml has no projectRoot field', async () => {
      const res = await runCLI(['recall', 'anything'], { HOME: homeDir }, projectRoot);
      expect(res.code, res.output).toBe(0);
      expect(res.output).not.toContain('not initialized');
    });
  });

  describe('hooks inject/remove manifest scoping (item 1)', () => {
    it('inject creates BOTH a project manifest and a user manifest, each tracking its own directory', async () => {
      const res = await runCLI(['hooks', 'inject'], { HOME: homeDir }, projectRoot);
      expect(res.code, res.output).toBe(0);

      const projectManifestPath = path.join(projectRoot, '.teamai', 'managed-hooks.json');
      const userManifestPath = path.join(homeDir, '.teamai', 'managed-hooks.json');
      expect(fs.existsSync(projectManifestPath)).toBe(true);
      expect(fs.existsSync(userManifestPath)).toBe(true);

      const projectManifest = JSON.parse(fs.readFileSync(projectManifestPath, 'utf-8'));
      const userManifest = JSON.parse(fs.readFileSync(userManifestPath, 'utf-8'));
      expect(projectManifest.claude?.[0]?.command).toContain('teamai-e2e-hook-marker');
      expect(userManifest.claude?.[0]?.command).toContain('teamai-e2e-hook-marker');

      // Both settings files actually received the hook (the #44 behavior of
      // also writing into the user's home dir must still work).
      const projectSettings = fs.readFileSync(path.join(projectRoot, '.claude', 'settings.json'), 'utf-8');
      const userSettings = fs.readFileSync(path.join(homeDir, '.claude', 'settings.json'), 'utf-8');
      expect(projectSettings).toContain('teamai-e2e-hook-marker');
      expect(userSettings).toContain('teamai-e2e-hook-marker');
    });

    it('re-running inject is idempotent — no duplicate hook entries in the user settings file', async () => {
      const before = fs.readFileSync(path.join(homeDir, '.claude', 'settings.json'), 'utf-8');
      const beforeCount = before.split('teamai-e2e-hook-marker').length - 1;

      const res = await runCLI(['hooks', 'inject'], { HOME: homeDir }, projectRoot);
      expect(res.code, res.output).toBe(0);

      const after = fs.readFileSync(path.join(homeDir, '.claude', 'settings.json'), 'utf-8');
      const afterCount = after.split('teamai-e2e-hook-marker').length - 1;
      expect(afterCount).toBe(beforeCount);
    });

    it('remove cleans up both the project and user copies', async () => {
      const res = await runCLI(['hooks', 'remove'], { HOME: homeDir }, projectRoot);
      expect(res.code, res.output).toBe(0);

      const projectSettings = fs.readFileSync(path.join(projectRoot, '.claude', 'settings.json'), 'utf-8');
      const userSettings = fs.readFileSync(path.join(homeDir, '.claude', 'settings.json'), 'utf-8');
      expect(projectSettings).not.toContain('teamai-e2e-hook-marker');
      expect(userSettings).not.toContain('teamai-e2e-hook-marker');
    });
  });

  describe('tags subscribe/unsubscribe scope isolation (item 2)', () => {
    it('subscribe writes to the project config, leaving the user config untouched', async () => {
      const res = await runCLI(['tags', 'subscribe', 'hai'], { HOME: homeDir }, projectRoot);
      expect(res.code, res.output).toBe(0);

      const projectConfig = fs.readFileSync(path.join(projectRoot, '.teamai', 'config.yaml'), 'utf-8');
      expect(projectConfig).toContain('hai');

      expect(fs.readFileSync(userConfigPath, 'utf-8')).toBe(userConfigBefore);
    });

    it('unsubscribe removes it again from the project config', async () => {
      const res = await runCLI(['tags', 'unsubscribe', 'hai'], { HOME: homeDir }, projectRoot);
      expect(res.code, res.output).toBe(0);

      const projectConfig = fs.readFileSync(path.join(projectRoot, '.teamai', 'config.yaml'), 'utf-8');
      expect(projectConfig).not.toContain('subscribedTags');
      expect(fs.readFileSync(userConfigPath, 'utf-8')).toBe(userConfigBefore);
    });
  });

  describe('contribute rebuilds the index immediately (item 3)', () => {
    it('a newly contributed learning is recallable without a separate `pull`', async () => {
      const docPath = path.join(sandbox, 'new-learning.md');
      fs.writeFileSync(
        docPath,
        '---\ntitle: "Zzyzx Contribution Marker"\nauthor: ci\ndate: 2026-07-01\ntags: [e2e]\n---\n\nUnique marker content for the e2e contribute test: Zzyzx Contribution Marker.\n',
      );

      const res = await runCLI(
        ['contribute', '--file', docPath, '--title', 'Zzyzx Contribution Marker'],
        { HOME: homeDir },
        projectRoot,
      );
      expect(res.code, res.output).toBe(0);

      const recallRes = await runCLI(['recall', 'Zzyzx Contribution Marker'], { HOME: homeDir }, projectRoot);
      expect(recallRes.code, recallRes.output).toBe(0);
      expect(recallRes.output).toContain('Zzyzx Contribution Marker');
    }, 20_000);
  });
});
