import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { expect, it } from 'vitest';

const CLI = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI', GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI', GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

it.each([false, true])('keeps installation ownership separate (shared team checkout: %s)', (sharedCheckout) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-source-manifest-')));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const env = { ...process.env, ...GIT_ENV, HOME: home, FORCE_COLOR: '0' };
  const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const run = (args: string[], cwd: string, expectedStatus = 0) => {
    const result = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8' });
    const output = result.stdout + result.stderr;
    expect(result.status, output).toBe(expectedStatus);
    return output;
  };
  const skill = (project: string, name: string) => path.join(project, '.claude', 'skills', name, 'SKILL.md');
  try {
    const legacyPath = path.join(home, '.teamai', 'sources', 'shared', 'installed.json');
    const legacyManifest = JSON.stringify({
      lastPull: '2026-01-01T00:00:00Z', installedSkills: ['legacy-local'],
      installedPaths: { 'legacy-local': ['.claude/skills/legacy-local'] },
    });
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, legacyManifest);
    const sourceSeed = path.join(root, 'source-seed');
    const sourceRemote = path.join(root, 'source.git');
    const sourceUrl = 'https://source.test/shared/skills.git';
    for (const name of ['old-skill', 'new-skill']) {
      fs.mkdirSync(path.join(sourceSeed, 'skills', name), { recursive: true });
      fs.writeFileSync(path.join(sourceSeed, 'skills', name, 'SKILL.md'), `# Source ${name}\n`);
    }
    const publish = (names: string[]) => fs.writeFileSync(path.join(sourceSeed, 'teamai.yaml'), YAML.stringify({ team: 'shared', repo: sourceUrl, publicSkills: names }));
    publish(['old-skill']);
    git(['init', '-q', '-b', 'main'], sourceSeed);
    git(['add', '-A'], sourceSeed);
    git(['commit', '-q', '-m', 'seed source'], sourceSeed);
    git(['clone', '-q', '--bare', sourceSeed, sourceRemote], root);
    git(['config', '--file', path.join(home, '.gitconfig'), `url.file://${sourceRemote}.insteadOf`, sourceUrl], root);
    const projects: string[] = [];
    const manifests: string[] = [];
    for (const name of ['alpha', 'beta']) {
      const project = path.join(root, name);
      const teamRepo = sharedCheckout ? path.join(root, 'shared-team-repo') : path.join(project, '.teamai', 'team-repo');
      const teamRemote = path.join(root, `${sharedCheckout ? 'shared' : name}-team.git`);
      const seedTeam = !fs.existsSync(teamRepo);
      fs.mkdirSync(teamRepo, { recursive: true });
      fs.mkdirSync(path.join(project, '.teamai'), { recursive: true });
      fs.mkdirSync(path.join(project, '.claude', 'skills'), { recursive: true });
      fs.mkdirSync(path.dirname(skill(project, 'legacy-local')), { recursive: true });
      fs.writeFileSync(skill(project, 'legacy-local'), `# ${name} legacy local draft\n`);
      if (seedTeam) {
        fs.writeFileSync(path.join(teamRepo, 'teamai.yaml'), YAML.stringify({
          team: name, repo: teamRemote, provider: 'git', reviewers: [],
          sources: [{ name: 'shared', repo: sourceUrl }],
          toolPaths: { claude: { skills: '.claude/skills' } },
        }));
        git(['init', '-q', '-b', 'main'], teamRepo);
        git(['add', '-A'], teamRepo);
        git(['commit', '-q', '-m', 'seed team'], teamRepo);
        git(['clone', '-q', '--bare', teamRepo, teamRemote], root);
        git(['remote', 'add', 'origin', teamRemote], teamRepo);
        git(['push', '-q', '--set-upstream', 'origin', 'main'], teamRepo);
      }
      fs.writeFileSync(path.join(project, '.teamai', 'config.yaml'), YAML.stringify({
        repo: { localPath: teamRepo, remote: teamRemote }, username: 'tester',
        updatePolicy: 'auto', scope: 'project', projectRoot: project,
      }));
      projects.push(project);
      const installationId = createHash('sha256').update(JSON.stringify([project, teamRepo])).digest('hex');
      manifests.push(path.join(home, '.teamai', 'sources', 'shared', 'installations', `${installationId}.json`));
    }
    expect(run(['push', '--dry-run'], projects[0])).toContain('Legacy tracking has no destination identity.');
    expect(fs.readFileSync(legacyPath, 'utf8')).toBe(legacyManifest);
    run(['pull', '--force'], projects[0]);
    expect(fs.readFileSync(skill(projects[0], 'old-skill'), 'utf8')).toBe('# Source old-skill\n');
    expect(fs.readFileSync(skill(projects[0], 'legacy-local'), 'utf8')).toBe('# alpha legacy local draft\n');
    fs.mkdirSync(path.dirname(skill(projects[1], 'old-skill')), { recursive: true });
    fs.writeFileSync(skill(projects[1], 'old-skill'), '# Beta local draft\n');
    publish(['new-skill']);
    git(['add', '-A'], sourceSeed);
    git(['commit', '-q', '-m', 'replace public skill'], sourceSeed);
    git(['push', '-q', sourceRemote, 'main'], sourceSeed);
    run(['pull', '--force'], projects[1]);
    expect(fs.existsSync(skill(projects[1], 'old-skill'))).toBe(true);
    expect(fs.readFileSync(skill(projects[1], 'old-skill'), 'utf8')).toBe('# Beta local draft\n');
    expect(fs.readFileSync(legacyPath, 'utf8')).toBe(legacyManifest);
    expect(fs.readFileSync(skill(projects[0], 'legacy-local'), 'utf8')).toBe('# alpha legacy local draft\n');
    expect(fs.readFileSync(skill(projects[1], 'legacy-local'), 'utf8')).toBe('# beta legacy local draft\n');
    expect(fs.readFileSync(skill(projects[1], 'new-skill'), 'utf8')).toBe('# Source new-skill\n');
    fs.mkdirSync(path.dirname(skill(projects[0], 'new-skill')), { recursive: true });
    fs.writeFileSync(skill(projects[0], 'new-skill'), '# Alpha local draft\n');
    const betaManifest = fs.readFileSync(manifests[1], 'utf8');
    run(['source', 'remove', 'shared'], projects[0]);
    expect(fs.existsSync(manifests[0])).toBe(false);
    expect(fs.readFileSync(manifests[1], 'utf8')).toBe(betaManifest);
    expect(fs.existsSync(skill(projects[0], 'old-skill'))).toBe(false);
    expect(fs.readFileSync(skill(projects[0], 'new-skill'), 'utf8')).toBe('# Alpha local draft\n');
    expect(fs.readFileSync(skill(projects[1], 'new-skill'), 'utf8')).toBe('# Source new-skill\n');
    const betaConfig = YAML.parse(fs.readFileSync(path.join(projects[1], '.teamai', 'config.yaml'), 'utf8'));
    const betaTeamYaml = path.join(betaConfig.repo.localPath, 'teamai.yaml');
    if (sharedCheckout) fs.appendFileSync(betaTeamYaml, '# Preserve this shared configuration comment.\n');
    const beforeBetaRemoval = fs.readFileSync(betaTeamYaml, 'utf8');
    if (sharedCheckout) expect(YAML.parse(beforeBetaRemoval).sources).toEqual([]);
    expect(run(['source', 'remove', 'shared', '--dry-run'], projects[1])).toContain('[dry-run] Would remove source "shared"');
    expect(fs.readFileSync(skill(projects[1], 'new-skill'), 'utf8')).toBe('# Source new-skill\n');
    expect(fs.readFileSync(betaTeamYaml, 'utf8')).toBe(beforeBetaRemoval);
    expect(fs.readFileSync(manifests[1], 'utf8')).toBe(betaManifest);
    const removeOutput = run(['source', 'remove', 'shared'], projects[1]);
    expect(removeOutput).toContain('Removed source "shared"');
    if (sharedCheckout) expect(removeOutput).not.toContain('Run `teamai push`');
    expect(fs.existsSync(manifests[1])).toBe(false);
    if (sharedCheckout) expect(fs.readFileSync(betaTeamYaml, 'utf8')).toBe(beforeBetaRemoval);
    expect(fs.existsSync(skill(projects[1], 'new-skill'))).toBe(false);
    expect(fs.readFileSync(skill(projects[1], 'old-skill'), 'utf8')).toBe('# Beta local draft\n');
    expect(fs.readFileSync(legacyPath, 'utf8')).toBe(legacyManifest);
    expect(run(['source', 'remove', 'shared'], projects[1], 1)).toContain('Source "shared" not found.');
    expect(fs.readFileSync(skill(projects[1], 'legacy-local'), 'utf8')).toBe('# beta legacy local draft\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

it.each([true, false])('removes stale ownership without deleting a replacement alias (identified stale manifest: %s)', (identified) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-source-alias-replacement-')));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const env = {
    ...process.env, ...GIT_ENV, HOME: home, USERPROFILE: home, FORCE_COLOR: '0',
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  };
  const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const run = (args: string[], cwd: string) => {
    const result = spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8', timeout: 30_000 });
    const output = result.stdout + result.stderr;
    expect(result.error, output).toBeUndefined();
    expect(result.status, output).toBe(0);
    return output;
  };
  const skill = (project: string, name: string) => path.join(project, '.claude', 'skills', name, 'SKILL.md');
  try {
    const sourceUrls = ['https://source.test/original/skills.git', 'https://source.test/replacement/skills.git'];
    for (const [index, name] of ['old-skill', 'new-skill'].entries()) {
      const sourceSeed = path.join(root, `${name}-source-seed`);
      const sourceRemote = path.join(root, `${name}-source.git`);
      fs.mkdirSync(path.join(sourceSeed, 'skills', name), { recursive: true });
      fs.writeFileSync(path.join(sourceSeed, 'skills', name, 'SKILL.md'), `# Source ${name}\n`);
      fs.writeFileSync(path.join(sourceSeed, 'teamai.yaml'), YAML.stringify({
        team: name, repo: sourceUrls[index], publicSkills: [name],
      }));
      git(['init', '-q', '-b', 'main'], sourceSeed);
      git(['add', '-A'], sourceSeed);
      git(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'seed source'], sourceSeed);
      git(['clone', '-q', '--bare', sourceSeed, sourceRemote], root);
      git(['config', '--file', path.join(home, '.gitconfig'), `url.file://${sourceRemote}.insteadOf`, sourceUrls[index]], root);
    }

    const teamRepo = path.join(root, 'shared-team-repo');
    const teamRemote = path.join(root, 'shared-team.git');
    const teamYaml = path.join(teamRepo, 'teamai.yaml');
    fs.mkdirSync(teamRepo);
    fs.writeFileSync(teamYaml, YAML.stringify({
      team: 'shared-checkout', repo: teamRemote, provider: 'git', reviewers: [],
      sources: [{ name: 'shared', repo: sourceUrls[0] }],
      toolPaths: { claude: { skills: '.claude/skills' } },
    }));
    git(['init', '-q', '-b', 'main'], teamRepo);
    git(['add', '-A'], teamRepo);
    git(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'seed team'], teamRepo);
    git(['clone', '-q', '--bare', teamRepo, teamRemote], root);
    git(['remote', 'add', 'origin', teamRemote], teamRepo);
    git(['push', '-q', '--set-upstream', 'origin', 'main'], teamRepo);

    const projects = ['alpha', 'beta'].map((name) => {
      const project = path.join(root, name);
      fs.mkdirSync(path.join(project, '.teamai'), { recursive: true });
      fs.mkdirSync(path.join(project, '.claude', 'skills'), { recursive: true });
      fs.writeFileSync(path.join(project, '.teamai', 'config.yaml'), YAML.stringify({
        repo: { localPath: teamRepo, remote: teamRemote }, username: 'tester',
        updatePolicy: 'skip', scope: 'project', projectRoot: project,
      }));
      const installationId = createHash('sha256').update(JSON.stringify([project, teamRepo])).digest('hex');
      const manifest = path.join(home, '.teamai', 'sources', 'shared', 'installations', `${installationId}.json`);
      run(['pull', '--force'], project);
      expect(fs.readFileSync(skill(project, 'old-skill'), 'utf8')).toBe('# Source old-skill\n');
      expect(JSON.parse(fs.readFileSync(manifest, 'utf8')).repositoryId)
        .toBe(createHash('sha256').update(sourceUrls[0]).digest('hex'));
      fs.mkdirSync(path.dirname(skill(project, 'local-draft')), { recursive: true });
      fs.writeFileSync(skill(project, 'local-draft'), `# ${name} local draft\n`);
      return { project, manifest };
    });
    const [alpha, beta] = projects;
    if (!identified) {
      const manifest = JSON.parse(fs.readFileSync(beta.manifest, 'utf8'));
      delete manifest.repositoryId;
      fs.writeFileSync(beta.manifest, JSON.stringify(manifest, null, 2));
    }
    const betaManifest = fs.readFileSync(beta.manifest, 'utf8');
    expect(run(['source', 'remove', 'shared'], alpha.project)).toContain('Removed source "shared"');
    expect(fs.existsSync(alpha.manifest)).toBe(false);
    expect(fs.existsSync(path.dirname(skill(alpha.project, 'old-skill')))).toBe(false);
    expect(fs.readFileSync(beta.manifest, 'utf8')).toBe(betaManifest);
    expect(fs.readFileSync(skill(beta.project, 'old-skill'), 'utf8')).toBe('# Source old-skill\n');
    expect(YAML.parse(fs.readFileSync(teamYaml, 'utf8')).sources).toEqual([]);

    expect(run(['source', 'add', sourceUrls[1], '--name', 'shared'], alpha.project)).toContain('Added source "shared"');
    run(['pull', '--force'], alpha.project);
    expect(fs.readFileSync(skill(alpha.project, 'new-skill'), 'utf8')).toBe('# Source new-skill\n');
    const alphaManifest = fs.readFileSync(alpha.manifest, 'utf8');
    expect(JSON.parse(alphaManifest).repositoryId).toBe(createHash('sha256').update(sourceUrls[1]).digest('hex'));
    expect(fs.readFileSync(beta.manifest, 'utf8')).toBe(betaManifest);
    fs.appendFileSync(teamYaml, '# Preserve the replacement source and this comment.\n');
    const replacementYaml = fs.readFileSync(teamYaml, 'utf8');
    expect(YAML.parse(replacementYaml).sources).toEqual([{ name: 'shared', repo: sourceUrls[1] }]);

    expect(run(['source', 'remove', 'shared', '--dry-run'], beta.project)).toContain('[dry-run] Would remove source "shared"');
    expect(fs.readFileSync(teamYaml, 'utf8')).toBe(replacementYaml);
    expect(fs.readFileSync(alpha.manifest, 'utf8')).toBe(alphaManifest);
    expect(fs.readFileSync(beta.manifest, 'utf8')).toBe(betaManifest);
    expect(fs.readFileSync(skill(alpha.project, 'new-skill'), 'utf8')).toBe('# Source new-skill\n');
    expect(fs.readFileSync(skill(beta.project, 'old-skill'), 'utf8')).toBe('# Source old-skill\n');

    const removeOutput = run(['source', 'remove', 'shared'], beta.project);
    expect(removeOutput).toContain('Removed source "shared"');
    expect(fs.existsSync(beta.manifest)).toBe(false);
    expect(fs.existsSync(path.dirname(skill(beta.project, 'old-skill')))).toBe(false);
    // Assert preservation immediately; a later pull must not repair the regression.
    expect(fs.readFileSync(teamYaml, 'utf8')).toBe(replacementYaml);
    expect(removeOutput).not.toContain('Run `teamai push`');
    expect(fs.readFileSync(alpha.manifest, 'utf8')).toBe(alphaManifest);
    expect(fs.readFileSync(skill(alpha.project, 'new-skill'), 'utf8')).toBe('# Source new-skill\n');
    expect(fs.readFileSync(skill(alpha.project, 'local-draft'), 'utf8')).toBe('# alpha local draft\n');
    expect(fs.readFileSync(skill(beta.project, 'local-draft'), 'utf8')).toBe('# beta local draft\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
