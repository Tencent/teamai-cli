import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { expect, it } from 'vitest';

const CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

it.each([
  { layout: 'missing', operation: 'install', foreignName: 'legacy', currentName: 'legacy', sameRepository: false },
  { layout: 'empty', operation: 'install', foreignName: 'legacy', currentName: 'legacy/child', sameRepository: true },
  { layout: 'mixed', operation: 'withdraw', foreignName: 'legacy/child', currentName: 'legacy', sameRepository: false },
  { layout: 'rootless-legacy', operation: 'remove', foreignName: 'legacy', currentName: 'legacy/child', sameRepository: false },
])('preserves a different checkout’s ambiguous claim ($layout, $operation)', ({ layout, operation, foreignName, currentName, sameRepository }) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-foreign-claim-cli-')));
  const home = path.join(root, 'home');
  const skills = path.join(home, '.claude/skills');
  fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
  fs.mkdirSync(skills, { recursive: true });
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, FORCE_COLOR: '0',
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'TeamAI CI', GIT_AUTHOR_EMAIL: 'ci@teamai.test',
    GIT_COMMITTER_NAME: 'TeamAI CI', GIT_COMMITTER_EMAIL: 'ci@teamai.test',
  };
  const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const run = (args: string[]) => {
    const result = spawnSync(process.execPath, [CLI, ...args], { cwd: home, env, encoding: 'utf8', timeout: 30_000 });
    const output = result.stdout + result.stderr;
    expect(result.error, output).toBeUndefined();
    expect(result.status, output).toBe(0);
    return output;
  };
  const commit = (cwd: string, message: string) => {
    git(['add', '-A'], cwd);
    git(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message], cwd);
  };
  const snapshot = (dir: string): Record<string, string> => {
    const files: Record<string, string> = {};
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      // The top-level pull independently bootstraps its builtin discovery skill and the default workflow's generated skill.
      if (dir === skills && (entry.name === 'teamai' || entry.name === 'workflow-session-close')) continue;
      if (entry.isDirectory()) {
        for (const [name, content] of Object.entries(snapshot(path.join(dir, entry.name)))) files[`${entry.name}/${name}`] = content;
      } else files[entry.name] = fs.readFileSync(path.join(dir, entry.name), 'utf8');
    }
    return files;
  };
  try {
    const sourceSeed = path.join(root, 'source-seed');
    const sourceRemote = path.join(root, 'source.git');
    const sourceUrl = 'https://source.test/foreign-claim/skills.git';
    const repositoryId = createHash('sha256').update(sourceUrl).digest('hex');
    const stageSource = (names: string[], revision: string) => {
      fs.mkdirSync(sourceSeed, { recursive: true });
      for (const name of names) {
        fs.mkdirSync(path.join(sourceSeed, 'skills', name), { recursive: true });
        fs.writeFileSync(path.join(sourceSeed, 'skills', name, 'SKILL.md'), `# ${revision} ${name}\n`);
      }
      fs.writeFileSync(path.join(sourceSeed, 'teamai.yaml'), YAML.stringify({ team: 'source', repo: sourceUrl, publicSkills: names }));
    };
    stageSource(operation === 'install' ? ['new-free', currentName] : ['owned-free', currentName], 'initial');
    git(['init', '-q', '-b', 'main'], sourceSeed);
    commit(sourceSeed, 'seed source');
    git(['clone', '-q', '--bare', sourceSeed, sourceRemote], root);
    git(['config', '--file', path.join(home, '.gitconfig'), `url.file://${sourceRemote}.insteadOf`, sourceUrl], root);

    const checkoutA = path.join(root, 'checkout-a');
    const checkoutB = path.join(root, 'checkout-b');
    const teamRemote = path.join(root, 'team.git');
    const teamYaml = path.join(checkoutB, 'teamai.yaml');
    fs.mkdirSync(checkoutA);
    fs.mkdirSync(checkoutB);
    fs.writeFileSync(teamYaml, YAML.stringify({
      team: 'consumer-b', repo: teamRemote, provider: 'git', reviewers: [],
      sources: [{ name: 'current', repo: sourceUrl }], toolPaths: { claude: { skills: '.claude/skills' } },
    }));
    git(['init', '-q', '-b', 'main'], checkoutB);
    commit(checkoutB, 'seed team');
    git(['clone', '-q', '--bare', checkoutB, teamRemote], root);
    git(['remote', 'add', 'origin', teamRemote], checkoutB);
    git(['push', '-q', '--set-upstream', 'origin', 'main'], checkoutB);
    fs.writeFileSync(path.join(home, '.teamai/config.yaml'), YAML.stringify({
      repo: { localPath: checkoutB, remote: teamRemote }, username: 'tester', updatePolicy: 'skip', scope: 'user',
    }));
    if (operation !== 'install') run(['pull', '--force']);

    const installationId = (checkout: string) => createHash('sha256').update(JSON.stringify([home, checkout])).digest('hex');
    let foreignPath = path.join(home, '.teamai/sources/retained/installations', `${installationId(checkoutA)}.json`);
    const foreignManifest: Record<string, unknown> = {
      destinationRoot: home, teamCheckout: checkoutA, installedSkills: [foreignName, 'foreign-recorded'],
      lastPull: new Date(0).toISOString(), repositoryId: sameRepository ? repositoryId : 'another-producer',
    };
    if (layout === 'empty') foreignManifest.installedPaths = { [foreignName]: [], 'foreign-recorded': [] };
    if (layout === 'mixed') foreignManifest.installedPaths = { 'foreign-recorded': ['.claude/skills/foreign-recorded'] };
    if (layout === 'rootless-legacy') {
      delete foreignManifest.destinationRoot;
      delete foreignManifest.teamCheckout;
      foreignManifest.installedPaths = { [foreignName]: [`.claude/skills/${foreignName}`] };
      foreignPath = path.join(home, '.teamai/sources/retained/installed.json');
    }
    fs.mkdirSync(path.dirname(foreignPath), { recursive: true });
    const foreignBefore = JSON.stringify(foreignManifest, null, 2);
    fs.writeFileSync(foreignPath, foreignBefore);
    for (const name of [foreignName, 'foreign-recorded']) {
      fs.mkdirSync(path.join(skills, name, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(skills, name, 'SKILL.md'), `# Retained checkout A ${name}\n`);
      fs.writeFileSync(path.join(skills, name, 'scripts/keep.txt'), `Keep checkout A ${name}\n`);
    }
    if (operation === 'withdraw') {
      stageSource(['new-free'], 'withdrawn');
      commit(sourceSeed, 'withdraw prior publication');
      git(['push', '-q', sourceRemote, 'main'], sourceSeed);
    }
    const currentPath = path.join(home, '.teamai/sources/current/installations', `${installationId(checkoutB)}.json`);
    const currentBefore = fs.existsSync(currentPath) ? fs.readFileSync(currentPath, 'utf8') : null;
    const yamlBefore = fs.readFileSync(teamYaml, 'utf8');
    const skillsBefore = snapshot(skills);
    const args = operation === 'remove' ? ['source', 'remove', 'current'] : ['pull', '--force'];

    for (const command of [args, [...args, '--dry-run']]) {
      const output = run(command);
      expect(snapshot(skills)).toEqual(skillsBefore);
      expect(fs.readFileSync(foreignPath, 'utf8')).toBe(foreignBefore);
      expect(fs.existsSync(currentPath) ? fs.readFileSync(currentPath, 'utf8') : null).toBe(currentBefore);
      expect(fs.readFileSync(teamYaml, 'utf8')).toBe(yamlBefore);
      expect(output.toLowerCase()).toContain('manual review');
      expect(output).toContain(foreignPath);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
