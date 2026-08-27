import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

interface RunResult {
  code: number | null;
  output: string;
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV },
  }).trim();
}

function runCLI(
  args: string[],
  cwd: string,
  home: string,
  envOverrides: Record<string, string> = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      cwd,
      env: {
        ...process.env,
        ...GIT_ENV,
        HOME: home,
        FORCE_COLOR: '0',
        ...envOverrides,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.on('close', (code) => resolve({ code, output }));
  });
}

describe('project-scope source lifecycle e2e (issue #335)', () => {
  it('persists, deploys, and removes a source through the dist CLI', async () => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }

    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-source-project-e2e-'));
    try {
      const home = path.join(sandbox, 'home');
      const projectRoot = path.join(sandbox, 'project');
      const teamSeed = path.join(sandbox, 'team-seed');
      const teamRemote = path.join(sandbox, 'team.git');
      const teamRepo = path.join(projectRoot, '.teamai', 'team-repo');
      const sourceSeed = path.join(sandbox, 'source-seed');
      const sourceRemote = path.join(sandbox, 'beta-source.git');
      const sourceUrl = 'https://source.test/root/beta-source.git';

      fs.mkdirSync(home, { recursive: true });
      fs.mkdirSync(path.join(projectRoot, '.claude', 'skills'), { recursive: true });
      fs.mkdirSync(teamSeed, { recursive: true });
      fs.writeFileSync(
        path.join(teamSeed, 'teamai.yaml'),
        [
          'team: issue-335-consumer',
          `repo: ${teamRemote}`,
          'provider: git',
          'reviewers: []',
          'toolPaths:',
          '  claude:',
          '    skills: .claude/skills',
        ].join('\n'),
      );
      git(['init', '-q', '-b', 'main'], teamSeed);
      git(['add', '-A'], teamSeed);
      git(['commit', '-q', '-m', 'seed consumer team'], teamSeed);
      git(['clone', '-q', '--bare', teamSeed, teamRemote], sandbox);
      git(['clone', '-q', teamRemote, teamRepo], projectRoot);

      fs.writeFileSync(
        path.join(projectRoot, '.teamai', 'config.yaml'),
        [
          'repo:',
          `  localPath: ${teamRepo}`,
          `  remote: ${teamRemote}`,
          'username: issue-335-user',
          'updatePolicy: auto',
          'scope: project',
          `projectRoot: ${projectRoot}`,
        ].join('\n'),
      );

      fs.mkdirSync(path.join(sourceSeed, 'skills', 'external-beta-skill'), { recursive: true });
      fs.writeFileSync(
        path.join(sourceSeed, 'teamai.yaml'),
        [
          'team: beta-source',
          `repo: ${sourceUrl}`,
          'provider: git',
          'reviewers: []',
          'publicSkills:',
          '  - external-beta-skill',
        ].join('\n'),
      );
      fs.writeFileSync(
        path.join(sourceSeed, 'skills', 'external-beta-skill', 'SKILL.md'),
        [
          '---',
          'name: external-beta-skill',
          'description: Source lifecycle E2E fixture',
          '---',
          '',
          '# External beta skill',
        ].join('\n'),
      );
      git(['init', '-q', '-b', 'main'], sourceSeed);
      git(['add', '-A'], sourceSeed);
      git(['commit', '-q', '-m', 'seed source team'], sourceSeed);
      git(['clone', '-q', '--bare', sourceSeed, sourceRemote], sandbox);

      const sourceGitEnv = {
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: `url.file://${sourceRemote}.insteadOf`,
        GIT_CONFIG_VALUE_0: sourceUrl,
        GIT_CONFIG_KEY_1: 'protocol.file.allow',
        GIT_CONFIG_VALUE_1: 'always',
      };

      const addResult = await runCLI(
        ['source', 'add', sourceUrl, '--name', 'beta-source'],
        projectRoot,
        home,
        sourceGitEnv,
      );
      expect(addResult.code, addResult.output).toBe(0);
      expect(addResult.output).toContain('Added source "beta-source"');

      const teamYamlPath = path.join(teamRepo, 'teamai.yaml');
      expect(YAML.parse(fs.readFileSync(teamYamlPath, 'utf8')).sources).toEqual([
        { name: 'beta-source', repo: sourceUrl },
      ]);

      const listResult = await runCLI(['source', 'list'], projectRoot, home, sourceGitEnv);
      expect(listResult.code, listResult.output).toBe(0);
      expect(listResult.output).toContain('beta-source (synced)');

      const browseResult = await runCLI(
        ['source', 'browse', 'beta-source'],
        projectRoot,
        home,
        sourceGitEnv,
      );
      expect(browseResult.code, browseResult.output).toBe(0);
      expect(browseResult.output).toContain('external-beta-skill');

      const pullResult = await runCLI(['pull', '--force'], projectRoot, home, sourceGitEnv);
      expect(pullResult.code, pullResult.output).toBe(0);
      expect(YAML.parse(fs.readFileSync(teamYamlPath, 'utf8')).sources).toEqual([
        { name: 'beta-source', repo: sourceUrl },
      ]);
      expect(
        fs.readFileSync(
          path.join(projectRoot, '.claude', 'skills', 'external-beta-skill', 'SKILL.md'),
          'utf8',
        ),
      ).toContain('# External beta skill');

      const manifestPath = path.join(home, '.teamai', 'sources', 'beta-source', 'installed.json');
      expect(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).installedSkills)
        .toEqual(['external-beta-skill']);

      const removeResult = await runCLI(
        ['source', 'remove', 'beta-source'],
        projectRoot,
        home,
        sourceGitEnv,
      );
      expect(removeResult.code, removeResult.output).toBe(0);
      expect(removeResult.output).toContain('Removed source "beta-source"');
      expect(YAML.parse(fs.readFileSync(teamYamlPath, 'utf8')).sources).toEqual([]);
      expect(fs.existsSync(path.dirname(manifestPath))).toBe(false);
      expect(
        fs.existsSync(path.join(projectRoot, '.claude', 'skills', 'external-beta-skill')),
      ).toBe(false);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  }, 60_000);
});
