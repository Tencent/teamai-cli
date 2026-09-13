import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// ─── DSH Team Context v0 end-to-end acceptance test ────────────────────────
//
// Drives the real, built CLI binary against three offline local git fixture
// repos (a DSH Team Context "upstream", a team repo that subscribes to it,
// and the machine-local clones/caches teamai maintains) — no network. This is
// the regression test backing the manual verification already done by hand;
// it must keep passing on every future change to team-context.ts / pull.ts.
//
// Proves, across a sequence of real `teamai pull`/`push` invocations with the
// DSH origin mutated in between:
//   1. initial pull materializes skill + rule + governance
//   2. an upstream content update propagates on the next pull
//   3. an upstream deletion tombstones the canonical skill + rule locally
//   4. a hand-edit inside the governance markers is reverted by the next pull
//   5. `push --dry-run` never picks up canonical skill/rule content
//   6. an invalid upstream schemaVersion fails loud and leaves the previous
//      valid state (skill/rule/governance) completely unchanged
//
// The DSH repo's cache dir is seeded via a direct `git clone` (bypassing
// teamai's git-provider abstraction, which — like the pre-existing peer
// `sources` feature — only resolves recognized host URL forms, not bare
// local paths). Every pull AFTER that seed exercises the real, unmocked
// `ensureRepoCache` → `pullRepo` → `simple-git` pull path against the local
// DSH origin, so upstream mutations are picked up through genuine git pulls.

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

function commitAll(dir: string, message: string): void {
  git('add -A', dir);
  git(`commit -q -m "${message}"`, dir);
}

/** Mirrors team-context.ts's own (unexported) cache-dir hashing so the test can seed it directly. */
function teamContextRepoDir(homeDir: string, dshRemote: string): string {
  const hash = createHash('sha256').update(dshRemote).digest('hex').slice(0, 16);
  return path.join(homeDir, '.teamai', 'team-context', hash, 'repo');
}

const SKILL_MD = [
  '---',
  'name: incident-response',
  'description: canonical incident response playbook',
  '---',
  '# Canonical incident response',
  '',
].join('\n');

const RULE_MD_ORIGINAL = '# Canonical security rule\nAlways rotate credentials after an incident.\n';
const RULE_MD_UPDATED = '# Canonical security rule\nUPDATED: rotate credentials within 1 hour.\n';
const RULE_MD_INVALID = '# THIS MUST NEVER LAND LOCALLY\n';
const GOVERNANCE_MD = 'All production changes require two reviewers.\n';
const GOVERNANCE_TAMPERED_MARKER = 'Reviews are optional now (tampered).';

function writeDshFixture(dir: string, opts: { schemaVersion?: number; ruleContent?: string; includeSkillAndRule?: boolean } = {}): void {
  const { schemaVersion = 1, ruleContent = RULE_MD_ORIGINAL, includeSkillAndRule = true } = opts;
  fs.rmSync(path.join(dir, 'skills'), { recursive: true, force: true });
  fs.rmSync(path.join(dir, 'rules'), { recursive: true, force: true });
  fs.writeFileSync(path.join(dir, 'team-context.yaml'), `schemaVersion: ${schemaVersion}\n`);
  fs.mkdirSync(path.join(dir, 'governance'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'governance', 'policy.md'), GOVERNANCE_MD);
  if (includeSkillAndRule) {
    fs.mkdirSync(path.join(dir, 'skills', 'incident-response'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'skills', 'incident-response', 'SKILL.md'), SKILL_MD);
    fs.mkdirSync(path.join(dir, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'rules', 'security-baseline.md'), ruleContent);
  }
}

describe('DSH Team Context v0 e2e (real CLI, real local git, no network)', () => {
  let sandbox: string;
  let homeDir: string;
  let dshRemote: string;
  let teamRemote: string;
  let teamLocal: string;

  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-team-context-e2e-'));
    homeDir = path.join(sandbox, 'home');
    fs.mkdirSync(path.join(homeDir, '.claude', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(homeDir, '.claude', 'rules'), { recursive: true });

    // ── DSH Team Context "upstream" ──
    dshRemote = path.join(sandbox, 'dsh-team-context-origin');
    fs.mkdirSync(dshRemote, { recursive: true });
    writeDshFixture(dshRemote);
    git('init -q', dshRemote);
    commitAll(dshRemote, 'init');

    // ── Team repo that subscribes to it ──
    teamRemote = path.join(sandbox, 'team-repo-origin');
    fs.mkdirSync(teamRemote, { recursive: true });
    fs.writeFileSync(
      path.join(teamRemote, 'teamai.yaml'),
      [
        'team: e2e-team',
        `repo: ${teamRemote}`,
        'provider: git',
        'teamContext:',
        `  repo: ${dshRemote}`,
      ].join('\n'),
    );
    git('init -q', teamRemote);
    commitAll(teamRemote, 'init');

    teamLocal = path.join(homeDir, '.teamai', 'team-repo');
    git(`clone -q "${teamRemote}" "${teamLocal}"`, sandbox);
    fs.writeFileSync(
      path.join(homeDir, '.teamai', 'config.yaml'),
      [
        'repo:',
        `  localPath: ${teamLocal}`,
        `  remote: ${teamRemote}`,
        'username: ci-user',
        'updatePolicy: auto',
        'scope: user',
      ].join('\n'),
    );

    // Seed the Team Context cache dir with a real clone. teamai's git-provider
    // abstraction (shared with peer `sources`) only resolves recognized host
    // URL forms, not bare local paths — the same reason source.test.ts never
    // exercises ensureRepoCache's first-clone branch either. Every pull from
    // here on exercises the real (unmocked) pull path against this clone.
    git(`clone -q "${dshRemote}" "${teamContextRepoDir(homeDir, dshRemote)}"`, sandbox);
  }, 60_000);

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('1. initial pull materializes skill + rule + governance', async () => {
    const res = await runCLI(['pull', '--force'], { HOME: homeDir }, sandbox);
    expect(res.code, res.output).toBe(0);

    expect(fs.existsSync(path.join(homeDir, '.claude', 'skills', 'incident-response', 'SKILL.md'))).toBe(true);
    expect(fs.readFileSync(path.join(homeDir, '.claude', 'rules', 'security-baseline.md'), 'utf-8'))
      .toContain('Always rotate credentials after an incident.');
    const claudeMd = fs.readFileSync(path.join(homeDir, '.claude', 'CLAUDE.md'), 'utf-8');
    expect(claudeMd).toContain('Team Context Governance');
    expect(claudeMd).toContain(GOVERNANCE_MD.trim());
  });

  it('2. an upstream content update propagates on the next pull', async () => {
    writeDshFixture(dshRemote, { ruleContent: RULE_MD_UPDATED });
    commitAll(dshRemote, 'update rule');

    const res = await runCLI(['pull', '--force'], { HOME: homeDir }, sandbox);
    expect(res.code, res.output).toBe(0);

    expect(fs.readFileSync(path.join(homeDir, '.claude', 'rules', 'security-baseline.md'), 'utf-8'))
      .toContain('UPDATED: rotate credentials within 1 hour.');
  });

  it('3. an upstream deletion tombstones the canonical skill + rule locally', async () => {
    writeDshFixture(dshRemote, { includeSkillAndRule: false });
    commitAll(dshRemote, 'remove skill and rule upstream');

    const res = await runCLI(['pull', '--force'], { HOME: homeDir }, sandbox);
    expect(res.code, res.output).toBe(0);

    expect(fs.existsSync(path.join(homeDir, '.claude', 'skills', 'incident-response'))).toBe(false);
    expect(fs.existsSync(path.join(homeDir, '.claude', 'rules', 'security-baseline.md'))).toBe(false);
    // Governance is untouched by this step — still present.
    expect(fs.readFileSync(path.join(homeDir, '.claude', 'CLAUDE.md'), 'utf-8')).toContain(GOVERNANCE_MD.trim());
  });

  it('4. a hand-edit inside the governance markers is reverted by the next pull', async () => {
    const claudeMdPath = path.join(homeDir, '.claude', 'CLAUDE.md');
    const tampered = fs.readFileSync(claudeMdPath, 'utf-8')
      .replace(GOVERNANCE_MD.trim(), GOVERNANCE_TAMPERED_MARKER);
    fs.writeFileSync(claudeMdPath, tampered);
    expect(fs.readFileSync(claudeMdPath, 'utf-8')).toContain(GOVERNANCE_TAMPERED_MARKER);

    const res = await runCLI(['pull', '--force'], { HOME: homeDir }, sandbox);
    expect(res.code, res.output).toBe(0);

    const restored = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(restored).toContain(GOVERNANCE_MD.trim());
    expect(restored).not.toContain(GOVERNANCE_TAMPERED_MARKER);
  });

  it('5. push --dry-run never picks up canonical skill/rule content', async () => {
    // Re-publish the skill + rule so there is canonical content on disk to
    // (incorrectly) surface as a push candidate if the exclusion regressed.
    writeDshFixture(dshRemote);
    commitAll(dshRemote, 're-add skill and rule');
    const pullRes = await runCLI(['pull', '--force'], { HOME: homeDir }, sandbox);
    expect(pullRes.code, pullRes.output).toBe(0);
    expect(fs.existsSync(path.join(homeDir, '.claude', 'skills', 'incident-response', 'SKILL.md'))).toBe(true);

    const pushRes = await runCLI(['push', '--dry-run'], { HOME: homeDir }, sandbox);
    expect(pushRes.code, pushRes.output).toBe(0);
    expect(pushRes.output).not.toContain('incident-response');
    expect(pushRes.output).not.toContain('security-baseline');
    expect(pushRes.output).toContain('No new or modified resources to push');
  });

  it('6. an invalid schemaVersion fails loud and leaves the previous valid state untouched', async () => {
    const ruleBefore = fs.readFileSync(path.join(homeDir, '.claude', 'rules', 'security-baseline.md'), 'utf-8');
    const skillBefore = fs.existsSync(path.join(homeDir, '.claude', 'skills', 'incident-response', 'SKILL.md'));
    const claudeMdBefore = fs.readFileSync(path.join(homeDir, '.claude', 'CLAUDE.md'), 'utf-8');

    writeDshFixture(dshRemote, { schemaVersion: 2, ruleContent: RULE_MD_INVALID });
    commitAll(dshRemote, 'bump to unsupported schema version');

    const res = await runCLI(['pull', '--force'], { HOME: homeDir }, sandbox);
    expect(res.code, res.output).toBe(0); // pull as a whole still succeeds; only this step is refused
    expect(res.output).toContain('unsupported schemaVersion');

    const ruleAfter = fs.readFileSync(path.join(homeDir, '.claude', 'rules', 'security-baseline.md'), 'utf-8');
    expect(ruleAfter).toBe(ruleBefore);
    expect(ruleAfter).not.toContain('THIS MUST NEVER LAND LOCALLY');
    expect(fs.existsSync(path.join(homeDir, '.claude', 'skills', 'incident-response', 'SKILL.md'))).toBe(skillBefore);
    expect(fs.readFileSync(path.join(homeDir, '.claude', 'CLAUDE.md'), 'utf-8')).toBe(claudeMdBefore);
  });
});
