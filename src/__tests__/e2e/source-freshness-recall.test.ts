import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI E2E',
  GIT_AUTHOR_EMAIL: 'e2e@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI E2E',
  GIT_COMMITTER_EMAIL: 'e2e@teamai.test',
  GIT_TERMINAL_PROMPT: '0',
};

const SOURCE_ORIGIN = 'https://source.example.invalid/teamai-freshness-fixture.git';
const WRONG_ORIGIN = 'https://source.example.invalid/different-repository.git';
const TEAM_REMOTE = 'https://knowledge.example.invalid/teamai-team.git';
const AUTH_SOURCE = [
  'export function refreshAccessToken(refreshToken: string): string {',
  '  return rotateRefreshToken(refreshToken);',
  '}',
  '',
  'function rotateRefreshToken(refreshToken: string): string {',
  '  return `access:${refreshToken}`;',
  '}',
  '',
].join('\n');
const UNRELATED_SOURCE = [
  'export function formatWebhookReceipt(eventId: string): string {',
  '  return `webhook:${eventId}`;',
  '}',
  '',
].join('\n');

interface RunResult {
  code: number | null;
  output: string;
}

function runCLI(args: string[], homeDir: string, cwd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        ...GIT_ENV,
        FORCE_COLOR: '0',
        HOME: homeDir,
        USERPROFILE: homeDir,
        TEAMAI_RECALL_DISABLED: '1',
        CLAUDE_SESSION_ID: 'source-freshness-e2e',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd,
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.on('close', (code) => resolve({ code, output }));
  });
}

function git(args: string[], cwd: string): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: { ...process.env, ...GIT_ENV },
  });
}

const yamlString = (value: string): string => JSON.stringify(value.replace(/\\/g, '/'));

function writeLocalConfig(homeDir: string, localPath: string): void {
  const teamaiDir = path.join(homeDir, '.teamai');
  fs.mkdirSync(teamaiDir, { recursive: true });
  fs.writeFileSync(path.join(teamaiDir, 'config.yaml'), [
    'repo:',
    `  localPath: ${yamlString(localPath)}`,
    `  remote: ${yamlString(TEAM_REMOTE)}`,
    '  kind: http',
    '  url: https://knowledge.example.invalid',
    'username: freshness-e2e',
    'scope: user',
    '',
  ].join('\n'));
}

function installFallbackWiki(repo: string, generatedWiki: string): void {
  const fallbackTeamRepo = path.join(repo, '.teamai', 'team-repo');
  fs.mkdirSync(fallbackTeamRepo, { recursive: true });
  fs.cpSync(generatedWiki, path.join(fallbackTeamRepo, 'teamwiki'), { recursive: true });
}

function snapshotTree(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        snapshot[`${path.relative(root, fullPath)}${path.sep}`] = '<directory>';
        walk(fullPath);
      } else if (entry.isFile() && entry.name !== 'gc.pid' && entry.name !== 'debug.log') {
        snapshot[path.relative(root, fullPath)] = createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex');
      }
    }
  };
  walk(root);
  return snapshot;
}

describe('source freshness on codebase recall (real CLI)', () => {
  let sandbox: string;
  let sourceRepo: string;
  let homeDir: string;
  let authPath: string;
  let unrelatedPath: string;
  let teamwiki: string;

  const recall = (repo = sourceRepo, extraArgs: string[] = []) =>
    runCLI(['recall', 'refresh access token', '--depth', 'lookup', ...extraArgs], homeDir, repo);

  beforeAll(async () => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`TeamAI CLI not found at ${CLI}. Run "npm run build" first.`);
    }

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-source-freshness-e2e-'));
    sourceRepo = path.join(sandbox, 'source-repo');
    homeDir = path.join(sandbox, 'home');
    authPath = path.join(sourceRepo, 'src', 'auth.ts');
    unrelatedPath = path.join(sourceRepo, 'src', 'webhook.ts');
    teamwiki = path.join(sourceRepo, 'teamwiki');
    fs.mkdirSync(path.dirname(authPath), { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
    fs.writeFileSync(authPath, AUTH_SOURCE);
    fs.writeFileSync(unrelatedPath, UNRELATED_SOURCE);
    fs.writeFileSync(path.join(sourceRepo, 'teamai.yaml'), [
      'team: freshness-e2e',
      'description: Isolated source freshness recall fixture',
      `repo: ${TEAM_REMOTE}`,
      'provider: github',
      'sharing:',
      '  recall:',
      '    enabled: true',
      '',
    ].join('\n'));

    git(['init'], sourceRepo);
    git(['remote', 'add', 'origin', SOURCE_ORIGIN], sourceRepo);
    git(['add', 'src/auth.ts', 'src/webhook.ts', 'teamai.yaml'], sourceRepo);
    git(['commit', '-m', 'baseline source snapshot'], sourceRepo);
    writeLocalConfig(homeDir, sourceRepo);

    const extracted = await runCLI(
      ['codebase', '--extract', sourceRepo, '--project', 'freshness-demo', '--json', '--max-files', '10'],
      homeDir,
      sourceRepo,
    );
    expect(extracted.code, extracted.output).toBe(0);

    const sourceManifestPath = path.join(teamwiki, 'evidence', 'code', 'freshness-demo', 'source-manifest.json');
    expect(fs.existsSync(sourceManifestPath), extracted.output).toBe(true);
    const sourceManifest = JSON.parse(fs.readFileSync(sourceManifestPath, 'utf8')) as {
      project?: string;
      repoIdentity?: string;
      sourceSubdir?: string;
      files?: Array<{ relativePath?: string; sha256?: string }>;
    };
    expect(sourceManifest.project).toBe('freshness-demo');
    expect(sourceManifest.repoIdentity).toContain('source.example.invalid');
    expect(sourceManifest.sourceSubdir).toBe('');
    expect(sourceManifest.files).toContainEqual(expect.objectContaining({
      relativePath: 'src/auth.ts',
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    installFallbackWiki(sourceRepo, teamwiki);
  }, 30_000);

  beforeEach(() => {
    fs.writeFileSync(authPath, AUTH_SOURCE);
    fs.writeFileSync(unrelatedPath, UNRELATED_SOURCE);
    writeLocalConfig(homeDir, sourceRepo);
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('labels source anchors current against the baseline created by codebase extraction', async () => {
    const result = await recall();

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('refreshAccessToken');
    expect(result.output).toMatch(/Source freshness:.*src\/auth\.ts=current \(last scan: [^)]*\)/);
  }, 30_000);

  it('marks an uncommitted change to a cited source as stale', async () => {
    fs.writeFileSync(authPath, AUTH_SOURCE.replace('rotateRefreshToken(refreshToken)', 'refreshToken + ":rotated"'));

    const result = await recall();

    expect(result.code, result.output).toBe(0);
    expect(result.output).toMatch(/Source freshness:.*src\/auth\.ts=stale/);
  }, 30_000);

  it('keeps the cited source current when only an unrelated file changes', async () => {
    fs.writeFileSync(unrelatedPath, UNRELATED_SOURCE.replace('webhook:${eventId}', 'webhook-v2:${eventId}'));

    const result = await recall();

    expect(result.code, result.output).toBe(0);
    expect(result.output).toMatch(/Source freshness:.*src\/auth\.ts=current \(last scan: [^)]*\)/);
  }, 30_000);

  it('marks a deleted source as missing', async () => {
    fs.rmSync(authPath);

    const result = await recall();

    expect(result.code, result.output).toBe(0);
    expect(result.output).toMatch(/Source freshness:.*src\/auth\.ts=missing/);
  }, 30_000);

  it('keeps --check lightweight and omits freshness annotation', async () => {
    fs.writeFileSync(authPath, AUTH_SOURCE.replace('rotateRefreshToken(refreshToken)', 'refreshToken + ":changed"'));
    const before = snapshotTree(sandbox);

    const result = await recall(sourceRepo, ['--check']);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('RELEVANT');
    expect(result.output).toContain('title=');
    expect(result.output).toContain('sources=');
    expect(result.output).not.toContain('Source freshness:');
    expect(result.output).not.toContain('last scan:');
    expect(snapshotTree(sandbox)).toEqual(before);
  }, 30_000);

  it('reports unknown when the knowledge base is used from a repository with a different origin', async () => {
    const wrongRepo = path.join(sandbox, 'wrong-repo');
    fs.rmSync(wrongRepo, { recursive: true, force: true });
    fs.mkdirSync(path.join(wrongRepo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(wrongRepo, 'src', 'auth.ts'), AUTH_SOURCE);
    fs.copyFileSync(path.join(sourceRepo, 'teamai.yaml'), path.join(wrongRepo, 'teamai.yaml'));
    git(['init'], wrongRepo);
    const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: wrongRepo,
      encoding: 'utf8',
      env: { ...process.env, ...GIT_ENV },
    }).trim();
    expect(path.resolve(gitRoot)).toBe(path.resolve(wrongRepo));
    git(['remote', 'add', 'origin', WRONG_ORIGIN], wrongRepo);
    installFallbackWiki(wrongRepo, teamwiki);
    writeLocalConfig(homeDir, wrongRepo);

    const result = await recall(wrongRepo);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toMatch(/Source freshness:.*src\/auth\.ts=unknown/);
  }, 30_000);

  it('does not write state for --dry-run after normal recall has initialized it', async () => {
    const initial = await recall();
    expect(initial.code, initial.output).toBe(0);
    fs.writeFileSync(authPath, AUTH_SOURCE.replace('rotateRefreshToken(refreshToken)', 'refreshToken + ":dry-run-change"'));
    const before = snapshotTree(sandbox);

    const preview = await recall(sourceRepo, ['--dry-run']);

    expect(preview.code, preview.output).toBe(0);
    expect(preview.output).toMatch(/Source freshness:.*src\/auth\.ts=stale/);
    expect(snapshotTree(sandbox)).toEqual(before);
  }, 30_000);
});
