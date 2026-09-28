import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { expect, it } from 'vitest';
import { teamRuleToCopilotInstructions } from '../../resources/copilot-instructions.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CLI = path.join(ROOT, 'dist/index.js');

it('push refreshes an unedited Copilot rule instead of pushing a rollback, and preserves real edits', () => {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-copilot-push-')));
  if (path.dirname(sandbox) !== fs.realpathSync(os.tmpdir())
    || !path.basename(sandbox).startsWith('teamai-copilot-push-')) {
    throw new Error('Unexpected test cleanup path');
  }
  const testHome = path.join(sandbox, 'home');
  const project = path.join(sandbox, 'project');
  const seed = path.join(sandbox, 'seed');
  const remote = path.join(sandbox, 'remote.git');
  const teammate = path.join(sandbox, 'teammate');
  const teamRepo = path.join(project, '.teamai/team-repo');
  const env = {
    ...process.env,
    HOME: testHome,
    USERPROFILE: testHome,
    COPILOT_HOME: path.join(testHome, '.copilot'),
    GIT_CONFIG_GLOBAL: path.join(testHome, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'TeamAI CI',
    GIT_AUTHOR_EMAIL: 'ci@teamai.test',
    GIT_COMMITTER_NAME: 'TeamAI CI',
    GIT_COMMITTER_EMAIL: 'ci@teamai.test',
    FORCE_COLOR: '0',
  };
  const put = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  const git = (args: string[], cwd = sandbox) => execFileSync('git', args, {
    cwd, env, encoding: 'utf8', windowsHide: true, timeout: 30_000, stdio: 'pipe',
  }).trim();
  const run = (args: string[]) => execFileSync(process.execPath, [CLI, ...args], {
    cwd: project, env, encoding: 'utf8', windowsHide: true, timeout: 30_000, stdio: 'pipe',
  });
  const v1 = '---\npaths: ["src/**/*.ts"]\n---\n\nUse the legacy endpoint.\n';
  const v2 = '---\npaths: ["lib/**/*.ts"]\n---\n\nUse the new endpoint.\n';
  const deployed = path.join(project, '.github/instructions/api.instructions.md');

  try {
    fs.mkdirSync(testHome, { recursive: true });
    put(path.join(seed, 'teamai.yaml'), YAML.stringify({
      team: 'copilot-push-test', repo: remote.replaceAll('\\', '/'), provider: 'git',
      autoUpdate: false, usageReport: false, sharing: { env: { injectShellProfile: false } },
    }));
    put(path.join(seed, 'rules/api.md'), v1);
    git(['init', '-q', '-b', 'main'], seed);
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'Rule v1'], seed);
    git(['clone', '-q', '--bare', seed, remote]);
    git(['clone', '-q', remote, teammate]);
    put(path.join(project, '.gitignore'), '.teamai/\n.github/\n');
    git(['init', '-q', '-b', 'main'], project);
    git(['add', '-A'], project);
    git(['commit', '-q', '-m', 'Project'], project);
    fs.mkdirSync(path.dirname(teamRepo), { recursive: true });
    git(['clone', '-q', remote, teamRepo]);
    put(path.join(project, '.teamai/config.yaml'), YAML.stringify({
      repo: { localPath: teamRepo, remote }, username: 'ci', updatePolicy: 'skip',
      scope: 'project', projectRoot: project, enabledAgents: ['copilot'], additionalRoles: [],
    }));

    run(['pull']);
    expect(fs.readFileSync(deployed, 'utf8')).toBe(teamRuleToCopilotInstructions(v1));
    put(path.join(teammate, 'rules/api.md'), v2);
    git(['commit', '-q', '-am', 'Teammate updates rule'], teammate);
    git(['push', '-q', 'origin', 'main'], teammate);

    // Pull migrates the legacy project config into the shared data directory.
    const dataRoot = path.join(testHome, '.teamai');
    const configs = fs.readdirSync(dataRoot, { recursive: true, encoding: 'utf8' })
      .filter((file) => path.basename(file) === 'config.yaml');
    expect(configs).toHaveLength(1);
    const configPath = path.join(dataRoot, configs[0]);
    const originalConfig = fs.readFileSync(configPath, 'utf8');
    const excludedCopy = teamRuleToCopilotInstructions(v1).replace('src/**/*.ts', 'custom/**/*.ts');
    put(deployed, excludedCopy);
    fs.mkdirSync(env.COPILOT_HOME, { recursive: true });
    for (const exclusion of [{ enabledAgents: ['claude'] }, { disabledAgents: ['copilot'] }]) {
      put(configPath, YAML.stringify({ ...YAML.parse(originalConfig), ...exclusion }));
      expect(run(['push', '--all'])).not.toContain('[rules] api (modified)');
      expect(fs.readFileSync(deployed, 'utf8')).toBe(excludedCopy);
    }
    put(configPath, originalConfig);

    const output = run(['push', '--all']);
    expect(output).not.toContain('[rules] api (modified)');
    expect(fs.readFileSync(deployed, 'utf8')).toBe(teamRuleToCopilotInstructions(v2));
    expect(git(['for-each-ref', '--format=%(refname)', 'refs/heads/teamai/push/'], remote)).toBe('');
    expect(git(['show', 'main:rules/api.md'], remote)).toBe(v2.trim());

    const pathsOnlyUpdate = v2.replace('lib/**/*.ts', 'api/**/*.ts');
    put(path.join(teammate, 'rules/api.md'), pathsOnlyUpdate);
    git(['commit', '-q', '-am', 'Teammate changes only paths'], teammate);
    git(['push', '-q', 'origin', 'main'], teammate);
    expect(run(['push', '--all'])).not.toContain('[rules] api (modified)');
    expect(fs.readFileSync(deployed, 'utf8')).toBe(teamRuleToCopilotInstructions(pathsOnlyUpdate));
    expect(git(['for-each-ref', '--format=%(refname)', 'refs/heads/teamai/push/'], remote)).toBe('');

    const edited = `${fs.readFileSync(deployed, 'utf8')}\nMy local addition.\n`;
    put(deployed, edited);
    expect(run(['--dry-run', 'push'])).toContain('[rules] api (modified)');
    expect(fs.readFileSync(deployed, 'utf8')).toBe(edited);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
