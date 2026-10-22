import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { getTeamSecretsPath } from '../../secret-store.js';
import { projectSlug } from '../../utils/partition.js';

// ─── A workspace delivers what the repos inside it select (#913) ────────────
//
// Run through the compiled CLI. A plain folder `ws/` is set up with `init`,
// and so is each repo inside it, each with its own project. A pull in `ws/`
// delivers the workspace's own selection plus every child's, names the
// children, and leaves out a child that uses another team repo. recall,
// contribute and push there read the same selection.
//
// The team remote is a synthetic HTTPS URL that git's `url.<base>.insteadOf`
// rewrites to a local bare repo, with a test-only `git` wrapper that reports
// the synthetic URL for `remote get-url` (see init-project-all.test.ts).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const FAKE_URL = 'https://git.example.com/team/team.git';
const OTHER_URL = 'https://git.example.com/other/team.git';

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

function git(args: string[], cwd: string, home?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV, ...(home ? { HOME: home, USERPROFILE: home } : {}) },
  }).trim();
}

function cloneBare(seed: string, bare: string): void {
  // Copy Git objects, not transient files a concurrent repack may remove.
  git(['clone', '-q', '--bare', '--no-local', seed, bare], path.dirname(bare));
}

describe('workspace bare-repo fixtures', () => {
  it('transfers both branches without copying temporary pack indexes', () => {
    const sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-bare-fixture-')));
    const seed = path.join(sandbox, 'seed');
    const bare = path.join(sandbox, 'team.git');
    try {
      fs.mkdirSync(seed);
      git(['init', '-q', '-b', 'main'], seed);
      fs.writeFileSync(path.join(seed, 'teamai.yaml'), 'team: fixture\n');
      git(['add', '-A'], seed);
      git(['commit', '-q', '-m', 'knowledge'], seed);
      git(['checkout', '-q', '--orphan', 'teamai-learnings'], seed);
      git(['rm', '-rfq', '.'], seed);
      fs.writeFileSync(path.join(seed, 'lesson.md'), '# Fixture learning\n');
      git(['add', '-A'], seed);
      git(['commit', '-q', '-m', 'learning'], seed);
      git(['checkout', '-q', 'main'], seed);

      const temporaryIndex = path.join('objects', 'pack', 'tmp_idx_fixture');
      const sourceIndex = path.join(seed, '.git', temporaryIndex);
      fs.mkdirSync(path.dirname(sourceIndex), { recursive: true });
      fs.writeFileSync(sourceIndex, 'An in-progress pack index is not a Git object.\n');

      cloneBare(seed, bare);

      expect(fs.existsSync(path.join(bare, temporaryIndex))).toBe(false);
      for (const ref of ['main', 'teamai-learnings']) {
        expect(git(['rev-parse', ref], bare)).toBe(git(['rev-parse', ref], seed));
      }
      expect(git(['show', 'main:teamai.yaml'], bare)).toBe('team: fixture');
      expect(git(['show', 'teamai-learnings:lesson.md'], bare)).toBe('# Fixture learning');
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

function installGitRemoteGetUrlWrapper(binDir: string): string {
  fs.mkdirSync(binDir, { recursive: true });
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  // The origin a clone reports is the URL it was cloned from, read back from
  // its config before insteadOf rewrites it.
  fs.writeFileSync(path.join(binDir, 'git'), `#!/bin/sh
if [ "$1" = "remote" ] && [ "$2" = "get-url" ]; then
  case "$3" in
    ""|origin|--all)
      url=$('${realGit}' config --get teamai-test.origin) && { printf '%s\\n' "$url"; exit 0; }
      ;;
  esac
fi
exec '${realGit}' "$@"
`, { mode: 0o755 });
  return binDir;
}

function runCLI(args: string[], cwd: string, home: string, extraEnv: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      cwd,
      env: { ...process.env, ...GIT_ENV, HOME: home, USERPROFILE: home, FORCE_COLOR: '0', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.on('close', (code) => resolve({ code, output }));
  });
}

function seedTeamRepo(seed: string, url: string): void {
  fs.mkdirSync(path.join(seed, 'manifest'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'teamai.yaml'), [
    'team: ws-children-e2e',
    `repo: ${url}`,
    'provider: git',
    'reviewers: []',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(seed, 'manifest', 'projects.yaml'), YAML.stringify({
    version: 1,
    projects: ['svc-a', 'svc-b', 'platform'].map((id) => ({
      id,
      resources: { skills: id === 'platform' ? [id] : [id, 'payments'], knowledge: [id], learnings: [id] },
    })),
  }));
  // A root instruction file svc-a replaces with its own; svc-b still reads the root one.
  fs.mkdirSync(path.join(seed, 'claudemd', 'svc-a'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'claudemd', 'style.md'), '# Style\n\nRoot style for every service.\n');
  fs.writeFileSync(path.join(seed, 'claudemd', 'svc-a', 'style.md'), '# Style\n\nStyle of svc-a.\n');
  fs.mkdirSync(path.join(seed, 'mcp'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'mcp', 'mcp.yaml'), 'servers:\n  - { name: team-db, transport: http, url: https://db.example.com/mcp }\n');
  for (const [namespace, name] of [['svc-a', 'svc-a-tool'], ['svc-a', 'svc-a-extra'], ['svc-b', 'svc-b-tool'], ['platform', 'platform-tool'], ['payments', 'payments-tool']]) {
    const dir = path.join(seed, 'skills', namespace!, name!);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: fixture\n---\n\n# ${name}\n`);
  }
}

describe('a workspace delivers what the repos inside it select (#913)', () => {
  let sandbox: string;
  let home: string;
  let ws: string;
  let cliEnv: Record<string, string>;

  const run = (args: string[], cwd: string): Promise<RunResult> => runCLI(args, cwd, home, cliEnv);
  const skillsIn = (root: string): string[] => {
    const dir = path.join(root, '.claude', 'skills');
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => !name.startsWith('teamai')).sort() : [];
  };
  const setUpRepo = async (dir: string, args: string[], url = FAKE_URL): Promise<void> => {
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    git(['init', '-q', '-b', 'main'], dir);
    git(['commit', '-q', '--allow-empty', '-m', 'init'], dir);
    const result = await run(['init', url, '--scope', 'workspace', '--agent', 'claude', '--force', ...args], dir);
    expect(result.code, result.output).toBe(0);
  };

  beforeAll(async () => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-ws-children-e2e-')));
    home = path.join(sandbox, 'home');
    ws = path.join(sandbox, 'ws');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });

    for (const [name, url] of [['team', FAKE_URL], ['other', OTHER_URL]] as const) {
      const seed = path.join(sandbox, `seed-${name}`);
      seedTeamRepo(seed, url);
      git(['init', '-q', '-b', 'main'], seed);
      git(['add', '-A'], seed);
      git(['commit', '-q', '-m', 'seed'], seed);
      // One learning per project, on the branch learnings are published to.
      git(['checkout', '-q', '--orphan', 'teamai-learnings'], seed);
      git(['rm', '-rfq', '.'], seed);
      for (const [namespace, word] of [['svc-a', 'narwhal'], ['platform', 'okapi']]) {
        fs.mkdirSync(path.join(seed, 'learnings', namespace!), { recursive: true });
        fs.writeFileSync(path.join(seed, 'learnings', namespace!, `${word}.md`), `# ${word} rollout\n\nThe ${word} rollout needs the ${word} cache warmed first.\n`);
      }
      git(['add', '-A'], seed);
      git(['commit', '-q', '-m', 'learnings'], seed);
      git(['checkout', '-q', 'main'], seed);
      const bare = path.join(sandbox, `${name}.git`);
      cloneBare(seed, bare);
      git(['config', '--global', `url.${bare}.insteadOf`, url], sandbox, home);
    }
    cliEnv = { PATH: `${installGitRemoteGetUrlWrapper(path.join(sandbox, 'bin'))}${path.delimiter}${process.env.PATH ?? ''}` };

    await setUpRepo(path.join(ws, 'svc-a'), ['--project', 'svc-a']);
    await setUpRepo(path.join(ws, 'backend', 'svc-b'), ['--project', 'svc-b']);
    await setUpRepo(path.join(ws, 'carol'), ['--project', 'svc-b'], OTHER_URL);
    for (const clone of fs.readdirSync(path.join(home, '.teamai', 'projects'))) {
      const config = YAML.parse(fs.readFileSync(path.join(home, '.teamai', 'projects', clone, 'config.yaml'), 'utf8'));
      git(['config', 'teamai-test.origin', config.repo.remote], config.repo.localPath);
    }
    const result = await run(['init', FAKE_URL, '--scope', 'workspace', '--agent', 'claude', '--force'], ws);
    expect(result.code, result.output).toBe(0);
    git(['config', 'teamai-test.origin', FAKE_URL], path.join(ws, '.teamai', 'team-repo'));
  }, 180_000);

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('delivers every child\'s projects, names the children, and leaves out one of another team repo', async () => {
    const result = await run(['pull'], ws);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('[workspace] Workspace with 2 children: backend/svc-b, svc-a');
    expect(result.output).toContain('[workspace] Workspace child carol is left out: it uses another team repo (https://git.example.com/other/team.git)');
    expect(skillsIn(ws)).toEqual(['payments-tool', 'svc-a-extra', 'svc-a-tool', 'svc-b-tool']);
  });

  it('gives the workspace the instructions of each child, a root file only one child replaces included', async () => {
    const result = await run(['pull', '--force'], ws);

    expect(result.code, result.output).toBe(0);
    const instructions = fs.readFileSync(path.join(ws, '.claude', 'rules', 'teamai-context.md'), 'utf8');
    expect(instructions).toContain('Style of svc-a.');
    expect(instructions).toContain('Root style for every service.');
  });

  it('follows a child that changes its selection without a team commit', async () => {
    const svcA = path.join(ws, 'svc-a');
    const exclude = await run(['skill', 'exclude', 'add', 'svc-a-extra'], svcA);
    expect(exclude.code, exclude.output).toBe(0);
    const projects = await run(['projects', 'set', 'svc-a', 'platform'], svcA);
    expect(projects.code, projects.output).toBe(0);

    const result = await run(['pull'], ws);

    expect(result.code, result.output).toBe(0);
    expect(result.output).not.toContain('Already synced');
    expect(skillsIn(ws)).toEqual(['payments-tool', 'platform-tool', 'svc-a-tool', 'svc-b-tool']);
  });

  it('gives the workspace\'s MCP servers to Claude through its local scope, so a child does not load them', async () => {
    const result = await run(['pull', '--force'], ws);

    expect(result.code, result.output).toBe(0);
    expect(fs.existsSync(path.join(ws, '.mcp.json'))).toBe(false);
    const claudeJson = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    expect(Object.keys(claudeJson.projects?.[ws]?.mcpServers ?? {})).toEqual(['team-db']);
  });

  it('keeps a scope without children as it was: its own selection, its project MCP file, no workspace line', async () => {
    const lone = path.join(sandbox, 'lone');
    await setUpRepo(lone, ['--project', 'svc-b']);
    git(['config', 'teamai-test.origin', FAKE_URL], YAML.parse(fs.readFileSync(path.join(home, '.teamai', 'projects', fs.readdirSync(path.join(home, '.teamai', 'projects')).find((slug) => slug.includes('lone'))!, 'config.yaml'), 'utf8')).repo.localPath);

    const result = await run(['pull'], lone);

    expect(result.code, result.output).toBe(0);
    expect(result.output).not.toContain('Workspace');
    expect(skillsIn(lone)).toEqual(['payments-tool', 'svc-b-tool']);
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(lone, '.mcp.json'), 'utf8')).mcpServers)).toEqual(['team-db']);
    expect(fs.existsSync(path.join(lone, '.claude', 'settings.local.json'))
      && JSON.parse(fs.readFileSync(path.join(lone, '.claude', 'settings.local.json'), 'utf8')).claudeMdExcludes).toBeFalsy();
    const state = JSON.parse(fs.readFileSync(path.join(home, '.teamai', 'projects', fs.readdirSync(path.join(home, '.teamai', 'projects')).find((slug) => slug.includes('lone'))!, 'state.json'), 'utf8'));
    expect(Object.values(state.lastPullByWorkspace).every((record) => !('children' in (record as object)))).toBe(true);
  });

  it('excludes the workspace\'s instructions from Claude Code in a child', async () => {
    const svcA = path.join(ws, 'svc-a');

    const result = await run(['pull'], svcA);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('[workspace] Excluded the instructions of the workspace above this repo from Claude Code sessions here');
    const settings = JSON.parse(fs.readFileSync(path.join(svcA, '.claude', 'settings.local.json'), 'utf8'));
    expect(settings.claudeMdExcludes).toEqual([
      path.join(ws, 'CLAUDE.md'), path.join(ws, '.claude', 'CLAUDE.md'), path.join(ws, 'AGENTS.md'), path.join(ws, '.claude', 'rules', '**'),
    ]);
  });

  it('shows the children in status, projects list and doctor', async () => {
    const status = await run(['status'], ws);
    expect(status.output).toContain('workspace: 2 children: backend/svc-b, svc-a (1 left out; run `teamai doctor` for why)');
    const projects = await run(['projects', 'list'], ws);
    expect(projects.output).toContain('This workspace also delivers what its children select:');
    expect(projects.output).toContain('  backend/svc-b: svc-b');
    expect(projects.output).toContain('  carol: left out, it uses another team repo (https://git.example.com/other/team.git)');
    const doctor = await run(['doctor'], ws);
    expect(doctor.output).toContain('The workspace reads every child set up under it');
    expect(doctor.output).toContain('carol is left out: it uses another team repo');
  });

  it('recalls the children\'s project learnings, and follows a child that changes its selection before the next pull', async () => {
    const recalledFile = async (word: string): Promise<string | undefined> => {
      const result = await run(['recall', word], ws);
      expect(result.code, result.output).toBe(0);
      return result.output.match(/^File: (.+)$/m)?.[1];
    };
    const pull = await run(['pull'], ws);
    expect(pull.code, pull.output).toBe(0);
    expect(await recalledFile('narwhal')).toContain(path.join('learnings', 'svc-a', 'narwhal.md'));
    expect(await recalledFile('okapi')).toContain(path.join('learnings', 'platform', 'okapi.md'));

    const projects = await run(['projects', 'set', 'svc-a'], path.join(ws, 'svc-a'));
    expect(projects.code, projects.output).toBe(0);

    expect(await recalledFile('okapi')).toBeUndefined();
    expect(await recalledFile('narwhal')).toContain(path.join('learnings', 'svc-a', 'narwhal.md'));
  });

  it('contributes to its own selection by default and to any namespace it reads with --namespace', async () => {
    const note = path.join(sandbox, 'note.md');
    fs.writeFileSync(note, '# Walrus cutover\n\nThe walrus cutover drains the queue before the switch.\n');
    const contribute = (args: string[]): Promise<RunResult> => run(['contribute', '--file', note, ...args], ws);

    const shared = await contribute(['--title', 'walrus-shared']);
    expect(shared.code, shared.output).toBe(0);
    expect(shared.output).toContain('Contributing to learnings/ (shared root). To choose a namespace, pass --namespace <ns>: svc-b, svc-a.');
    expect(shared.output).toMatch(/Contributed: learnings\/walrus-shared-/);

    const child = await contribute(['--title', 'walrus-child', '--namespace', 'svc-b']);
    expect(child.code, child.output).toBe(0);
    expect(child.output).toMatch(/Contributed: learnings\/svc-b\/walrus-child-/);
    const recall = await run(['recall', 'narwhal'], ws);
    expect(recall.output.match(/^File: (.+)$/m)?.[1]).toContain(path.join('learnings', 'svc-a', 'narwhal.md'));

    const own = await run(['projects', 'set', 'platform'], ws);
    expect(own.code, own.output).toBe(0);
    const projects = await run(['projects', 'list'], ws);
    expect(projects.output).toContain('Contributes to: learnings/platform/   --namespace accepts: platform, svc-b, svc-a');
    const owned = await contribute(['--title', 'walrus-own']);
    expect(owned.code, owned.output).toBe(0);
    expect(owned.output).toMatch(/Contributed: learnings\/platform\/walrus-own-/);
    expect(owned.output).not.toContain('To choose a namespace');
  });

  it('pushes an edit back to every child namespace whose copy it came from, and an agent to its child namespace', async () => {
    const seed = path.join(sandbox, 'seed-team');
    const publish = (message: string): void => {
      git(['add', '-A'], seed);
      git(['commit', '-q', '-m', message], seed);
      git(['push', '-q', path.join(sandbox, 'team.git'), 'main'], seed);
    };
    const manifest = YAML.parse(fs.readFileSync(path.join(seed, 'manifest', 'projects.yaml'), 'utf8'));
    for (const project of manifest.projects) project.resources.agents = [project.id];
    fs.writeFileSync(path.join(seed, 'manifest', 'projects.yaml'), YAML.stringify(manifest));
    fs.mkdirSync(path.join(seed, 'agents', 'svc-a'), { recursive: true });
    fs.writeFileSync(path.join(seed, 'agents', 'svc-a', 'helper.yaml'),
      'name: helper\ndescription: Help with svc-a\ninstructions: Answer questions about svc-a.\n');
    const teamSkill = (namespace: string, name: string, body: string): void => {
      fs.mkdirSync(path.join(seed, 'skills', namespace, name), { recursive: true });
      fs.writeFileSync(path.join(seed, 'skills', namespace, name, 'SKILL.md'), `---\nname: ${name}\ndescription: fixture\n---\n\n${body}\n`);
    };
    for (const namespace of ['svc-a', 'svc-b']) {
      teamSkill(namespace, 'shared-tool', 'Shared by both services.');
      teamSkill(namespace, 'drift-tool', 'Shared until svc-b changes it.');
    }
    publish('shared skills and an agent');
    expect((await run(['pull'], ws)).code).toBe(0);
    teamSkill('svc-b', 'drift-tool', 'Changed by svc-b.');
    publish('svc-b changes its copy');
    const pull = await run(['pull'], ws);
    expect(pull.code, pull.output).toBe(0);
    expect(pull.output).toContain('Skill "drift-tool" differs between');

    for (const file of ['skills/shared-tool/SKILL.md', 'skills/drift-tool/SKILL.md', 'agents/helper.md']) {
      fs.appendFileSync(path.join(ws, '.claude', file), '\nEdited in the workspace.\n');
    }
    const result = await run(['push', '--dry-run'], ws);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('to:   skills/svc-a/shared-tool');
    expect(result.output).toContain('to:   skills/svc-b/shared-tool');
    expect(result.output).toContain('to:   skills/svc-a/drift-tool');
    expect(result.output).not.toContain('to:   skills/svc-b/drift-tool');
    expect(result.output).toContain('skills/svc-b/drift-tool changed on the team');
    expect(result.output).toMatch(/\[agents\] helper \(modified\)\n\s+from: .+\n\s+to:   agents\/svc-a\/helper\.yaml/);

    const pushed = await run(['push', '--all'], ws);
    expect(pushed.output).toContain('Pushed branch teamai/push/');
    const bare = path.join(sandbox, 'team.git');
    const branch = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/teamai/push/'], bare);
    const changed = git(['diff', '--name-only', 'main', branch], bare).split('\n');
    expect(changed.filter((file) => !file.endsWith('/CONTRIBUTORS')).sort()).toEqual([
      'agents/svc-a/helper.yaml', 'skills/svc-a/drift-tool/SKILL.md', 'skills/svc-a/shared-tool/SKILL.md', 'skills/svc-b/shared-tool/SKILL.md',
    ]);
  });

  it('keeps a hook only a child selects when the workspace injects its hooks again', async () => {
    const seed = path.join(sandbox, 'seed-team');
    const manifest = YAML.parse(fs.readFileSync(path.join(seed, 'manifest', 'projects.yaml'), 'utf8'));
    for (const project of manifest.projects) project.resources.hooks = [project.id];
    fs.writeFileSync(path.join(seed, 'manifest', 'projects.yaml'), YAML.stringify(manifest));
    fs.mkdirSync(path.join(seed, 'hooks', 'svc-b'), { recursive: true });
    fs.writeFileSync(path.join(seed, 'hooks', 'svc-b', 'hooks.yaml'),
      'hooks:\n  - id: svc-b-check\n    description: Check svc-b commands\n    event: PreToolUse\n    matcher: Bash\n    command: echo svc-b-check-913\n    tools: [claude]\n');
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'a hook for svc-b'], seed);
    git(['push', '-q', path.join(sandbox, 'team.git'), 'main'], seed);
    const claudeHooks = (): string => ['settings.json', 'settings.local.json']
      .map((file) => path.join(ws, '.claude', file)).filter((file) => fs.existsSync(file))
      .map((file) => fs.readFileSync(file, 'utf8')).join('\n');
    const pull = await run(['pull'], ws);
    expect(pull.code, pull.output).toBe(0);
    expect(claudeHooks()).toContain('svc-b-check-913');

    const inject = await run(['hooks', 'inject'], ws);

    expect(inject.code, inject.output).toBe(0);
    expect(claudeHooks()).toContain('svc-b-check-913');
  });

  it('keeps the installed copy of an agent two children ship differently, and names it', async () => {
    const seed = path.join(sandbox, 'seed-team');
    const publish = (message: string): void => {
      git(['add', '-A'], seed);
      git(['commit', '-q', '-m', message], seed);
      git(['push', '-q', path.join(sandbox, 'team.git'), 'main'], seed);
    };
    const teamAgent = (namespace: string, body: string): void => {
      fs.mkdirSync(path.join(seed, 'agents', namespace), { recursive: true });
      fs.writeFileSync(path.join(seed, 'agents', namespace, 'reviewer.yaml'), `name: reviewer\ndescription: Review changes\ninstructions: ${body}\n`);
    };
    teamAgent('svc-a', 'Review as svc-a does.');
    publish('a reviewer agent for svc-a');
    expect((await run(['pull'], ws)).code).toBe(0);
    const installed = path.join(ws, '.claude', 'agents', 'reviewer.md');
    const before = fs.readFileSync(installed, 'utf8');
    expect(before).toContain('Review as svc-a does.');

    teamAgent('svc-b', 'Review as svc-b does.');
    publish('svc-b ships its own reviewer');
    const result = await run(['pull'], ws);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('Agent "reviewer" differs between agents/svc-b/reviewer.yaml and agents/svc-a/reviewer.yaml, so this workspace holds it back; an installed copy is kept.');
    expect(fs.readFileSync(installed, 'utf8')).toBe(before);
  });

  it('keeps the installed MCP server two children define differently, and names it', async () => {
    const seed = path.join(sandbox, 'seed-team');
    const publish = (message: string): void => {
      git(['add', '-A'], seed);
      git(['commit', '-q', '-m', message], seed);
      git(['push', '-q', path.join(sandbox, 'team.git'), 'main'], seed);
    };
    const teamServer = (namespace: string, url: string): void => {
      fs.mkdirSync(path.join(seed, 'mcp', namespace), { recursive: true });
      fs.writeFileSync(path.join(seed, 'mcp', namespace, 'mcp.yaml'), `servers:\n  - { name: svc-api, transport: http, url: ${url} }\n`);
    };
    const manifest = YAML.parse(fs.readFileSync(path.join(seed, 'manifest', 'projects.yaml'), 'utf8'));
    for (const project of manifest.projects) project.resources.mcp = [project.id];
    fs.writeFileSync(path.join(seed, 'manifest', 'projects.yaml'), YAML.stringify(manifest));
    teamServer('svc-a', 'https://svc-a.example.com/mcp');
    publish('an MCP server for svc-a');
    expect((await run(['pull'], ws)).code).toBe(0);
    const installed = (): unknown => JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).projects?.[ws]?.mcpServers?.['svc-api'];
    expect(installed()).toMatchObject({ url: 'https://svc-a.example.com/mcp' });

    teamServer('svc-b', 'https://svc-b.example.com/mcp');
    publish('svc-b defines its own svc-api');
    const result = await run(['pull'], ws);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('mcp: server "svc-api" differs between mcp/svc-b/mcp.yaml and mcp/svc-a/mcp.yaml, so this workspace holds it back; an installed copy is kept.');
    expect(result.output).not.toMatch(/MCP: \d+ change/);
    expect(installed()).toMatchObject({ url: 'https://svc-a.example.com/mcp' });
  });

  // Each case below pulls, then runs a normal command, and checks that the
  // command keeps or shows what the pull delivered.

  const publish = (message: string, edit: (seed: string) => void): void => {
    const seed = path.join(sandbox, 'seed-team');
    edit(seed);
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', message], seed);
    git(['push', '-q', path.join(sandbox, 'team.git'), 'main'], seed);
  };
  const selectNamespaces = (seed: string, type: string): void => {
    const file = path.join(seed, 'manifest', 'projects.yaml');
    const manifest = YAML.parse(fs.readFileSync(file, 'utf8'));
    for (const project of manifest.projects) project.resources[type] = [project.id];
    fs.writeFileSync(file, YAML.stringify(manifest));
  };
  const claudeLocalServer = (name: string): unknown =>
    JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).projects?.[ws]?.mcpServers?.[name];

  it('keeps the children\'s MCP servers in Claude\'s local scope when the workspace runs mcp inject', async () => {
    const before = claudeLocalServer('svc-api');
    expect(before).toMatchObject({ url: 'https://svc-a.example.com/mcp' });

    const result = await run(['mcp', 'inject'], ws);

    expect(result.code, result.output).toBe(0);
    expect(claudeLocalServer('svc-api')).toEqual(before);
    expect(fs.existsSync(path.join(ws, '.mcp.json'))).toBe(false);
  });

  it('lists and runs with the env a child selects, as the workspace\'s pull installed it', async () => {
    publish('an env variable for svc-a', (seed) => {
      selectNamespaces(seed, 'env');
      fs.mkdirSync(path.join(seed, 'env', 'svc-a'), { recursive: true });
      fs.writeFileSync(path.join(seed, 'env', 'svc-a', 'env.yaml'), 'variables:\n  - key: WS_CHILD_ENDPOINT\n    value: https://child.example.com\n');
    });
    const pull = await run(['pull'], ws);
    expect(pull.code, pull.output).toBe(0);
    expect(fs.readFileSync(path.join(ws, '.teamai', 'env.sh'), 'utf8')).toContain('WS_CHILD_ENDPOINT');

    const list = await run(['env', 'list'], ws);
    const exec = await run(['env', 'exec', '--', 'node', '-e', 'console.log(process.env.WS_CHILD_ENDPOINT ?? "MISSING")'], ws);

    expect(list.output).toContain('WS_CHILD_ENDPOINT');
    expect(exec.output).toContain('https://child.example.com');
  });

  it('lists the model profile a child selects, which the workspace\'s pull announced', async () => {
    publish('a model profile for svc-a', (seed) => {
      selectNamespaces(seed, 'models');
      fs.mkdirSync(path.join(seed, 'models', 'svc-a'), { recursive: true });
      fs.writeFileSync(path.join(seed, 'models', 'svc-a', 'models.yaml'), YAML.stringify({
        profiles: [{ id: 'child-model', name: 'Child model', base_url: 'https://models.example.com', api_key: '${API_KEY}', model_groups: [{ protocols: ['anthropic'], models: ['child-llm'] }] }],
      }));
    });
    const pull = await run(['pull'], ws);
    expect(pull.code, pull.output).toBe(0);
    expect(pull.output).toContain('1 team model profile(s) available');

    const list = await run(['models', 'list'], ws);

    expect(list.output).toContain('team:child-model');
  });

  it('pushes an edit only to the namespaces that delivered it, not to an equal root skill', async () => {
    publish('an equal skill at the root and in both services', (seed) => {
      for (const namespace of ['', 'svc-a', 'svc-b']) {
        fs.mkdirSync(path.join(seed, 'skills', namespace, 'catalog-twin'), { recursive: true });
        fs.writeFileSync(path.join(seed, 'skills', namespace, 'catalog-twin', 'SKILL.md'), '---\nname: catalog-twin\ndescription: fixture\n---\n\nThe same skill.\n');
      }
    });
    expect((await run(['pull'], ws)).code).toBe(0);
    fs.appendFileSync(path.join(ws, '.claude', 'skills', 'catalog-twin', 'SKILL.md'), '\nEdited in the workspace.\n');

    const dryRun = await run(['push', '--dry-run'], ws);
    expect(dryRun.output).toContain('to:   skills/svc-a/catalog-twin');
    expect(dryRun.output).toContain('to:   skills/svc-b/catalog-twin');
    const pushed = await run(['push', '--all'], ws);

    expect(pushed.output).toContain('Pushed branch teamai/push/');
    const bare = path.join(sandbox, 'team.git');
    const branches = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/teamai/push/'], bare).split('\n').filter(Boolean);
    const changed = branches.flatMap((branch) => git(['diff', '--name-only', 'main', branch], bare).split('\n'));
    expect(changed).toContain('skills/svc-a/catalog-twin/SKILL.md');
    expect(changed).not.toContain('skills/catalog-twin/SKILL.md');
  });

  it('does not deliver a held MCP server that no pull delivered, even one it excluded before', async () => {
    publish('svc-a defines a server', (seed) => {
      fs.writeFileSync(path.join(seed, 'mcp', 'svc-a', 'mcp.yaml'), 'servers:\n  - { name: never-shipped, transport: http, url: https://a.example.com }\n');
      fs.writeFileSync(path.join(seed, 'mcp', 'svc-b', 'mcp.yaml'), 'servers: []\n');
    });
    expect((await run(['skill', 'exclude', 'add', 'never-shipped'], ws)).code).toBe(0);
    expect((await run(['pull'], ws)).code).toBe(0);
    expect(claudeLocalServer('never-shipped')).toBeUndefined();
    publish('svc-b defines it differently', (seed) => {
      fs.writeFileSync(path.join(seed, 'mcp', 'svc-b', 'mcp.yaml'), 'servers:\n  - { name: never-shipped, transport: http, url: https://b.example.com }\n');
    });
    expect((await run(['skill', 'exclude', 'remove', 'never-shipped'], ws)).code).toBe(0);

    const result = await run(['pull'], ws);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('server "never-shipped" differs between');
    expect(claudeLocalServer('never-shipped')).toBeUndefined();
  });

  it('does not deliver a held MCP server that allowedHosts kept out of every earlier pull', async () => {
    publish('svc-a defines a server on a host the team does not allow', (seed) => {
      fs.appendFileSync(path.join(seed, 'teamai.yaml'), 'sharing:\n  mcp:\n    allowedHosts: ["*.example.com"]\n');
      fs.writeFileSync(path.join(seed, 'mcp', 'svc-a', 'mcp.yaml'), 'servers:\n  - { name: gated-host, transport: http, url: https://a.example.net }\n');
    });
    expect((await run(['pull'], ws)).code).toBe(0);
    expect(claudeLocalServer('gated-host')).toBeUndefined();
    publish('the team allows the host, and svc-b defines the server differently', (seed) => {
      const file = path.join(seed, 'teamai.yaml');
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('["*.example.com"]', '["*.example.com", "*.example.net"]'));
      fs.writeFileSync(path.join(seed, 'mcp', 'svc-b', 'mcp.yaml'), 'servers:\n  - { name: gated-host, transport: http, url: https://b.example.net }\n');
    });

    const result = await run(['pull'], ws);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('server "gated-host" differs between');
    expect(claudeLocalServer('gated-host')).toBeUndefined();
  });

  it('takes a held skill out once the workspace excludes it, when its copy equals the version of a child other than the first', async () => {
    // As the first pull delivered it, which only svc-a, the second child, still ships.
    const installed = path.join(ws, '.claude', 'skills', 'drift-tool', 'SKILL.md');
    fs.copyFileSync(path.join(sandbox, 'seed-team', 'skills', 'svc-a', 'drift-tool', 'SKILL.md'), installed);
    expect((await run(['skill', 'exclude', 'add', 'drift-tool'], ws)).code).toBe(0);

    const result = await run(['pull'], ws);

    expect(result.code, result.output).toBe(0);
    expect(fs.existsSync(installed), result.output).toBe(false);
    expect(result.output).not.toContain('Kept skill "drift-tool"');
    expect(result.output).not.toContain('Skill "drift-tool" differs');
    expect((await run(['skill', 'exclude', 'remove', 'drift-tool'], ws)).code).toBe(0);
  });

  it('takes a held skill out once the workspace excludes it, when its copy holds no change of the member\'s', async () => {
    const installed = path.join(ws, '.claude', 'skills', 'drift-tool', 'SKILL.md');
    fs.mkdirSync(path.dirname(installed), { recursive: true });
    fs.copyFileSync(path.join(sandbox, 'seed-team', 'skills', 'svc-b', 'drift-tool', 'SKILL.md'), installed);
    expect((await run(['skill', 'exclude', 'add', 'drift-tool'], ws)).code).toBe(0);

    const result = await run(['pull'], ws);

    expect(result.code, result.output).toBe(0);
    expect(fs.existsSync(installed), result.output).toBe(false);
    expect(result.output).not.toContain('Skill "drift-tool" differs');
  });

  it('keeps the workspace\'s hooks out of every checkout of a child, a linked worktree included', async () => {
    publish('a workspace hook for Cursor', (seed) => {
      fs.writeFileSync(path.join(seed, 'hooks', 'hooks.yaml'),
        'hooks:\n  - id: ws-stop\n    description: Workspace stop hook\n    event: Stop\n    command: echo ws-hook-ran\n    tools: [cursor]\n');
    });
    const svcA = path.join(ws, 'svc-a');
    const worktree = path.join(ws, 'svc-a-feature');
    git(['worktree', 'add', '-q', '-b', 'feature', worktree], svcA);
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    const configFile = path.join(ws, '.teamai', 'config.yaml');
    fs.writeFileSync(configFile, YAML.stringify({ ...YAML.parse(fs.readFileSync(configFile, 'utf8')), enabledAgents: ['claude', 'cursor'] }));

    const pull = await run(['pull'], ws);

    expect(pull.code, pull.output).toBe(0);
    expect(pull.output).toContain('[workspace] Workspace with 2 children: backend/svc-b, svc-a');
    const stop: Array<{ command: string }> = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'hooks.json'), 'utf8')).hooks.stop;
    const command = stop.find((entry) => entry.command.includes('ws-hook-ran'))!.command;
    const runIn = (cwd: string): string => execFileSync('sh', ['-c', command], { cwd, encoding: 'utf8', env: { ...process.env, PWD: cwd } });
    expect(runIn(ws)).toContain('ws-hook-ran');
    expect(runIn(svcA)).toBe('');
    expect(runIn(worktree)).toBe('');
  });

  it('takes back the workspace instruction excludes a child owns when the child is uninstalled', async () => {
    const svcA = path.join(ws, 'svc-a');
    const settings = path.join(svcA, '.claude', 'settings.local.json');
    fs.writeFileSync(settings, JSON.stringify({ ...JSON.parse(fs.readFileSync(settings, 'utf8')), claudeMdExcludes: [
      ...JSON.parse(fs.readFileSync(settings, 'utf8')).claudeMdExcludes, '/elsewhere/CLAUDE.md',
    ] }, null, 2));

    const result = await run(['uninstall', '--force'], svcA);

    expect(result.code, result.output).toBe(0);
    const excludes = fs.existsSync(settings) ? JSON.parse(fs.readFileSync(settings, 'utf8')).claudeMdExcludes : undefined;
    expect(excludes).toEqual(['/elsewhere/CLAUDE.md']);
  });
  it('keeps one copy of the workspace\'s Cursor hook, gated out of a child added between pulls', async () => {
    const cursorCommands = (): string[] => {
      const hooks: Record<string, Array<{ command: string }>> = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'hooks.json'), 'utf8')).hooks;
      return Object.values(hooks).flat().map((entry) => entry.command).filter((command) => command.includes('ws-hook-ran'));
    };
    expect((await run(['pull'], ws)).code).toBe(0);
    expect(cursorCommands()).toHaveLength(1);
    const late = path.join(ws, 'late-child');
    const config = YAML.parse(fs.readFileSync(path.join(ws, '.teamai', 'config.yaml'), 'utf8'));
    fs.mkdirSync(path.join(late, '.teamai'), { recursive: true });
    fs.writeFileSync(path.join(late, '.teamai', 'config.yaml'), YAML.stringify({ ...config, projects: ['svc-b'] }));

    const result = await run(['pull'], ws);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('late-child');
    const commands = cursorCommands();
    expect(commands).toHaveLength(1);
    const runIn = (cwd: string): string => execFileSync('sh', ['-c', commands[0]!], { cwd, encoding: 'utf8', env: { ...process.env, PWD: cwd } });
    expect(runIn(ws)).toContain('ws-hook-ran');
    expect(runIn(late)).toBe('');
  });
});


// ─── A name a workspace holds back keeps what is installed (#913) ───────────
//
// A workspace of its own (`--project platform`) that gets its children while
// the cases run. A held name is left as each tool has it installed: no add,
// no update, no removal. Where it is installed follows the current rules.

describe('a workspace keeps what is installed for a name it holds back (#913)', () => {
  let sandbox: string;
  let home: string;
  let ws: string;
  let cliEnv: Record<string, string>;

  const run = (args: string[], cwd: string): Promise<RunResult> => runCLI(args, cwd, home, cliEnv);
  const setUpChild = async (dir: string, project: string): Promise<void> => {
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    git(['init', '-q', '-b', 'main'], dir);
    git(['commit', '-q', '--allow-empty', '-m', 'init'], dir);
    const result = await run(['init', FAKE_URL, '--scope', 'workspace', '--agent', 'claude', '--force', '--project', project], dir);
    expect(result.code, result.output).toBe(0);
    for (const clone of fs.readdirSync(path.join(home, '.teamai', 'projects'))) {
      const config = YAML.parse(fs.readFileSync(path.join(home, '.teamai', 'projects', clone, 'config.yaml'), 'utf8'));
      git(['config', 'teamai-test.origin', FAKE_URL], config.repo.localPath);
    }
  };
  const publish = (message: string, edit: (seed: string) => void): void => {
    const seed = path.join(sandbox, 'seed-team');
    edit(seed);
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', message], seed);
    git(['push', '-q', path.join(sandbox, 'team.git'), 'main'], seed);
  };
  const writeEntries = (seed: string, type: string, namespace: string, document: object, file = `${type}.yaml`): void => {
    fs.mkdirSync(path.join(seed, type, namespace), { recursive: true });
    fs.writeFileSync(path.join(seed, type, namespace, file), YAML.stringify(document));
  };
  const extend = (seed: string, type: string, namespace: string, key: string, items: object[]): void => {
    const file = path.join(seed, type, namespace, `${type}.yaml`);
    const document = fs.existsSync(file) ? YAML.parse(fs.readFileSync(file, 'utf8')) ?? {} : {};
    writeEntries(seed, type, namespace, { ...document, [key]: [...document[key] ?? [], ...items] });
  };
  const envSh = (): string => fs.readFileSync(path.join(ws, '.teamai', 'env.sh'), 'utf8');
  // Once `ws` is a git repository, a pull moves its data home to its partition.
  const dataHome = (): string => fs.existsSync(path.join(ws, '.teamai', 'config.yaml'))
    ? path.join(ws, '.teamai') : path.join(home, '.teamai', 'projects', projectSlug(ws));
  const mcpManifests = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? mcpManifests(path.join(dir, entry.name)) : entry.name === 'managed-mcp.json' ? [path.join(dir, entry.name)] : []);
  const claudeHooks = (): string => fs.readFileSync(path.join(ws, '.claude', 'settings.local.json'), 'utf8');
  const cursorCommand = (marker: string): string | undefined => {
    const hooks: Record<string, Array<{ command: string }>> = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'hooks.json'), 'utf8')).hooks;
    return Object.values(hooks).flat().find((entry) => entry.command.includes(marker))?.command;
  };
  const claudeLocalServer = (name: string): { url?: string } | undefined =>
    JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).projects?.[ws]?.mcpServers?.[name];
  const projectFileServer = (name: string): { url?: string } | undefined => {
    const file = path.join(ws, '.mcp.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers?.[name] : undefined;
  };

  beforeAll(async () => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-ws-held-e2e-')));
    home = path.join(sandbox, 'home');
    ws = path.join(sandbox, 'ws');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(ws, '.codex'), { recursive: true });

    const seed = path.join(sandbox, 'seed-team');
    seedTeamRepo(seed, FAKE_URL);
    const manifest = YAML.parse(fs.readFileSync(path.join(seed, 'manifest', 'projects.yaml'), 'utf8'));
    for (const project of manifest.projects) Object.assign(project.resources, { env: [project.id], hooks: [project.id], mcp: [project.id] });
    fs.writeFileSync(path.join(seed, 'manifest', 'projects.yaml'), YAML.stringify(manifest));
    git(['init', '-q', '-b', 'main'], seed);
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'seed'], seed);
    const bare = path.join(sandbox, 'team.git');
    cloneBare(seed, bare);
    git(['config', '--global', `url.${bare}.insteadOf`, FAKE_URL], sandbox, home);
    cliEnv = { PATH: `${installGitRemoteGetUrlWrapper(path.join(sandbox, 'bin'))}${path.delimiter}${process.env.PATH ?? ''}` };

    const result = await run(['init', FAKE_URL, '--scope', 'workspace', '--agent', 'claude', '--force', '--project', 'platform'], ws);
    expect(result.code, result.output).toBe(0);
    git(['config', 'teamai-test.origin', FAKE_URL], path.join(ws, '.teamai', 'team-repo'));
    const configFile = path.join(ws, '.teamai', 'config.yaml');
    fs.writeFileSync(configFile, YAML.stringify({ ...YAML.parse(fs.readFileSync(configFile, 'utf8')), enabledAgents: ['claude', 'codex', 'cursor'] }));
  }, 180_000);

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('keeps the env key, MCP server and hook it installed before a child defined them differently, and names each', async () => {
    const define = (seed: string, namespace: string): void => {
      writeEntries(seed, 'env', namespace, { variables: [{ key: 'WS_HELD', value: `${namespace}-value` }] });
      writeEntries(seed, 'mcp', namespace, { servers: [{ name: 'held-api', transport: 'http', url: `https://${namespace}.example.com/mcp` }] });
      writeEntries(seed, 'hooks', namespace, { hooks: [{ id: 'held-hook', description: 'Held hook', event: 'Stop', command: `echo held-${namespace}`, tools: ['claude', 'cursor'] }] });
    };
    publish('platform defines an env key, a server and a hook', (seed) => define(seed, 'platform'));
    const first = await run(['pull'], ws);
    expect(first.code, first.output).toBe(0);
    expect(first.output).not.toContain('Workspace with');
    expect(envSh()).toContain("WS_HELD='platform-value'");
    expect(projectFileServer('held-api')?.url).toBe('https://platform.example.com/mcp');
    expect(claudeHooks()).toContain('echo held-platform');
    expect(cursorCommand('held-platform')).toBeDefined();

    publish('svc-a defines them differently', (seed) => define(seed, 'svc-a'));
    await setUpChild(path.join(ws, 'svc-a'), 'svc-a');
    const result = await run(['pull'], ws);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('[workspace] Workspace with 1 child: svc-a');
    expect(result.output).toContain('env: variable "WS_HELD" differs between env/platform/env.yaml and env/svc-a/env.yaml');
    expect(result.output).toContain('mcp: server "held-api" differs between mcp/platform/mcp.yaml and mcp/svc-a/mcp.yaml');
    expect(result.output).toContain('hooks: hook "held-hook" differs between hooks/platform/hooks.yaml and hooks/svc-a/hooks.yaml');
    expect(envSh()).toContain("WS_HELD='platform-value'");
    expect(claudeHooks()).toContain('echo held-platform');
    expect(claudeHooks()).not.toContain('echo held-svc-a');
    expect(cursorCommand('held-platform')).toBeDefined();
    expect(cursorCommand('held-svc-a')).toBeUndefined();
    expect((claudeLocalServer('held-api') ?? projectFileServer('held-api'))?.url).toBe('https://platform.example.com/mcp');
    // The env backup records the value alone, not the file or description it came from.
    expect((await run(['env', 'list'], ws)).output).toMatch(/WS_HELD=\S+ {2}installed {2}\(held back\)/);
  });

  it('moves a held MCP server it installed in .mcp.json to Claude\'s local scope, so a child does not load it', async () => {
    const result = await run(['pull'], ws);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('mcp: server "held-api" differs between');
    expect(claudeLocalServer('held-api')?.url).toBe('https://platform.example.com/mcp');
    expect(projectFileServer('held-api')).toBeUndefined();
  });

  it('gates a held hook out of every child, one set up while the hook is held included', async () => {
    const svcB = path.join(ws, 'backend', 'svc-b');
    await setUpChild(svcB, 'svc-b');

    const result = await run(['pull'], ws);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('[workspace] Workspace with 2 children: backend/svc-b, svc-a');
    expect(result.output).toContain('hooks: hook "held-hook" differs between');
    const command = cursorCommand('held-platform')!;
    const runIn = (cwd: string): string => execFileSync('sh', ['-c', command], { cwd, encoding: 'utf8', env: { ...process.env, PWD: cwd } });
    expect(runIn(ws)).toContain('held-platform');
    expect(runIn(path.join(ws, 'svc-a'))).toBe('');
    expect(runIn(svcB)).toBe('');
  });

  it('keeps the env value a pull installed for a held key when a later pull could not deliver env', async () => {
    const storeFile = path.join(home, '.teamai', 'secrets', 'teams',
      path.basename(getTeamSecretsPath(YAML.parse(fs.readFileSync(path.join(ws, '.teamai', 'config.yaml'), 'utf8')))));
    const define = (seed: string, namespace: string, value: string): void => {
      writeEntries(seed, 'env', namespace, { variables: [{ key: 'WS_HELD', value: `${namespace}-value` }, { key: 'WS_RECORD_ENV', value }] });
    };
    publish('svc-a defines WS_RECORD_ENV', (seed) => define(seed, 'svc-a', 'first-env'));
    expect((await run(['pull'], ws)).code).toBe(0);
    expect(envSh()).toContain("WS_RECORD_ENV='first-env'");
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    fs.writeFileSync(storeFile, '{broken');
    publish('svc-a changes it while the member\'s values cannot be read', (seed) => define(seed, 'svc-a', 'never-env'));
    await run(['pull'], ws);
    expect(envSh()).toContain("WS_RECORD_ENV='first-env'");
    fs.writeFileSync(storeFile, '{}');
    publish('platform defines it differently', (seed) => define(seed, 'platform', 'platform-env'));

    const result = await run(['pull'], ws);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('env: variable "WS_RECORD_ENV" differs between');
    expect(envSh()).toContain("WS_RECORD_ENV='first-env'");
  });

  it('keeps the env value installed while the workspace had no children when they come back with another', async () => {
    publish('svc-a alone defines WS_RETURN', (seed) => {
      writeEntries(seed, 'env', 'svc-a', { variables: [{ key: 'WS_HELD', value: 'svc-a-value' }, { key: 'WS_RETURN', value: 'child-v1' }] });
      writeEntries(seed, 'env', 'platform', { variables: [{ key: 'WS_HELD', value: 'platform-value' }] });
    });
    expect((await run(['pull'], ws)).code).toBe(0);
    expect(envSh()).toContain("WS_RETURN='child-v1'");
    const parked = path.join(sandbox, 'parked');
    fs.mkdirSync(parked, { recursive: true });
    const children = ['svc-a', 'backend'].filter((dir) => fs.existsSync(path.join(ws, dir)));
    for (const dir of children) fs.renameSync(path.join(ws, dir), path.join(parked, dir));
    publish('platform defines WS_RETURN too', (seed) => {
      writeEntries(seed, 'env', 'platform', { variables: [{ key: 'WS_HELD', value: 'platform-value' }, { key: 'WS_RETURN', value: 'own-v3' }] });
    });
    const alone = await run(['pull'], ws);
    expect(alone.output).not.toContain('Workspace with');
    expect(envSh()).toContain("WS_RETURN='own-v3'");
    for (const dir of children) fs.renameSync(path.join(parked, dir), path.join(ws, dir));

    const result = await run(['pull'], ws);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('env: variable "WS_RETURN" differs between');
    expect(envSh()).toContain("WS_RETURN='own-v3'");
  });

  it('keeps a held hook that hooks inject installed, when the team does not apply hooks on pull', async () => {
    const hooks = (namespace: string): object => ({
      hooks: [
        { id: 'held-hook', description: 'Held hook', event: 'Stop', command: `echo held-${namespace}`, tools: ['claude', 'cursor'] },
        { id: 'inject-hook', description: 'Injected hook', event: 'Stop', command: `echo inject-${namespace}`, tools: ['claude'] },
      ],
    });
    const teamYaml = path.join(sandbox, 'seed-team', 'teamai.yaml');
    const shared = fs.readFileSync(teamYaml, 'utf8');
    publish('hooks wait for hooks inject, and platform adds inject-hook', (seed) => {
      fs.appendFileSync(teamYaml, 'sharing:\n  hooks:\n    autoApply: false\n');
      writeEntries(seed, 'hooks', 'platform', hooks('platform'));
    });
    try {
      expect((await run(['pull'], ws)).code).toBe(0);
      expect((await run(['hooks', 'inject'], ws)).code).toBe(0);
      expect(claudeHooks()).toContain('echo inject-platform');
      publish('svc-a defines inject-hook differently', (seed) => writeEntries(seed, 'hooks', 'svc-a', hooks('svc-a')));
      expect((await run(['pull'], ws)).code).toBe(0);

      const result = await run(['hooks', 'inject'], ws);

      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain('hooks: hook "inject-hook" differs between');
      expect(claudeHooks()).toContain('echo inject-platform');
      expect(claudeHooks()).not.toContain('echo inject-svc-a');
    } finally {
      publish('hooks apply on pull again', () => fs.writeFileSync(teamYaml, shared));
    }
  });

  it('keeps the hook a pull installed for a held id when a later pull could not write the tool\'s file', async () => {
    const hook = (seed: string, namespace: string, command: string): void => {
      writeEntries(seed, 'hooks', namespace, { hooks: [{ id: 'failed-hook', description: 'fixture', event: 'Stop', command, tools: ['claude'] }] });
    };
    publish('svc-a defines failed-hook', (seed) => hook(seed, 'svc-a', 'echo first-hook'));
    expect((await run(['pull'], ws)).code).toBe(0);
    const settings = path.join(ws, '.claude', 'settings.local.json');
    const installed = fs.readFileSync(settings, 'utf8');
    expect(installed).toContain('echo first-hook');
    fs.writeFileSync(settings, '{broken');
    publish('svc-a changes it while Claude\'s settings do not parse', (seed) => hook(seed, 'svc-a', 'echo never-hook'));
    await run(['pull'], ws);
    fs.writeFileSync(settings, installed);
    publish('platform defines failed-hook differently', (seed) => hook(seed, 'platform', 'echo different-hook'));

    const result = await run(['pull'], ws);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('hooks: hook "failed-hook" differs between');
    expect(claudeHooks()).toContain('echo first-hook');
    expect(claudeHooks()).not.toContain('echo never-hook');
    expect(claudeHooks()).not.toContain('echo different-hook');
  });

  it('keeps each tool\'s installed version of a held MCP server, one a tool skipped while disabled included', async () => {
    const server = (seed: string, namespace: string, url: string): void => {
      writeEntries(seed, 'mcp', namespace, { servers: [{ name: 'partial-tool', transport: 'http', url }] });
    };
    const codexConfig = (): string => fs.readFileSync(path.join(ws, '.codex', 'config.toml'), 'utf8');
    publish('svc-a defines partial-tool', (seed) => server(seed, 'svc-a', 'https://first.example.com'));
    expect((await run(['pull'], ws)).code).toBe(0);
    expect(claudeLocalServer('partial-tool')?.url).toBe('https://first.example.com');
    expect(codexConfig()).toContain('https://first.example.com');
    const configFile = path.join(ws, '.teamai', 'config.yaml');
    const config = YAML.parse(fs.readFileSync(configFile, 'utf8'));
    fs.writeFileSync(configFile, YAML.stringify({ ...config, disabledAgents: ['claude'] }));
    publish('svc-a changes it while Claude is disabled', (seed) => server(seed, 'svc-a', 'https://second.example.com'));
    expect((await run(['pull'], ws)).code).toBe(0);
    expect(codexConfig()).toContain('https://second.example.com');
    fs.writeFileSync(configFile, YAML.stringify(config));
    publish('platform defines partial-tool differently', (seed) => server(seed, 'platform', 'https://third.example.com'));

    const result = await run(['pull'], ws);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('mcp: server "partial-tool" differs between');
    expect(claudeLocalServer('partial-tool')?.url).toBe('https://first.example.com');
    expect(codexConfig()).toContain('https://second.example.com');
    expect(codexConfig()).not.toContain('https://third.example.com');
  });

  it('declares a secret two members describe differently, from the first, and names it instead of holding it back', async () => {
    publish('platform and svc-a describe WS_TOKEN differently', (seed) => {
      writeEntries(seed, 'env', 'platform', { secrets: [{ key: 'WS_TOKEN', description: 'Token for the platform API' }] }, 'secrets.yaml');
      writeEntries(seed, 'env', 'svc-a', { secrets: [{ key: 'WS_TOKEN', description: 'Token for the svc-a API', url: 'https://svc-a.example.com/token' }] }, 'secrets.yaml');
    });

    const result = await run(['pull'], ws);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('secrets: secret "WS_TOKEN" is described differently in env/platform/secrets.yaml and env/svc-a/secrets.yaml; this workspace shows the first.');
    expect(result.output).not.toContain('secret "WS_TOKEN" differs');
    const list = await run(['env', 'list'], ws);
    expect(list.output).toMatch(/Team secrets \(1\):\s+WS_TOKEN\s+missing\s+\(platform\)/);
  });

  it('runs with the variable a member set with --from-env for a held key', async () => {
    publish('platform defines WS_FROM_ENV', (seed) => extend(seed, 'env', 'platform', 'variables', [{ key: 'WS_FROM_ENV', value: 'platform-from-env' }]));
    expect((await run(['pull'], ws)).code).toBe(0);
    const set = await run(['env', 'set', 'WS_FROM_ENV', '--from-env', 'MEMBER_FROM_ENV'], ws);
    expect(set.code, set.output).toBe(0);
    expect((await run(['pull'], ws)).code).toBe(0);
    expect(envSh()).not.toContain('WS_FROM_ENV');
    publish('svc-a defines WS_FROM_ENV differently', (seed) => extend(seed, 'env', 'svc-a', 'variables', [{ key: 'WS_FROM_ENV', value: 'svc-a-from-env' }]));

    const result = await run(['pull'], ws);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('env: variable "WS_FROM_ENV" differs between');
    expect(envSh()).not.toContain('WS_FROM_ENV');
    const exec = (env: Record<string, string>): Promise<RunResult> =>
      runCLI(['env', 'exec', '--', 'sh', '-c', 'printf "[%s]" "${WS_FROM_ENV-unset}"'], ws, home, { ...cliEnv, ...env });
    expect((await exec({ MEMBER_FROM_ENV: 'member-value' })).output).toContain('[member-value]');
    expect((await exec({})).output).toContain('[unset]');
  });

  it('moves a held MCP server with the credential it resolved, and keeps Claude\'s file to the member', async () => {
    const server = (url: string, headers?: object): object => ({ name: 'held-credential', transport: 'http', url, ...headers ? { headers } : {} });
    const parked = path.join(sandbox, 'parked-credential');
    fs.mkdirSync(parked, { recursive: true });
    const children = ['svc-a', 'backend'].filter((dir) => fs.existsSync(path.join(ws, dir)));
    for (const dir of children) fs.renameSync(path.join(ws, dir), path.join(parked, dir));
    publish('platform defines held-credential, with a header from MOVE_TOKEN', (seed) => {
      extend(seed, 'mcp', 'platform', 'servers', [server('https://held.example.com/mcp', { 'X-Test': '${MOVE_TOKEN}' })]);
      extend(seed, 'env', 'platform', 'variables', [{ key: 'MOVE_TOKEN', value: 'short' }]);
    });
    const alone = await run(['pull'], ws);
    expect(alone.code, alone.output).toBe(0);
    const tree = path.join(ws, '.mcp.json');
    expect(fs.readFileSync(tree, 'utf8')).toContain('short');
    expect(fs.statSync(tree).mode & 0o777).toBe(0o600);
    const userFile = path.join(home, '.claude.json');
    fs.chmodSync(userFile, 0o644);
    for (const dir of children) fs.renameSync(path.join(parked, dir), path.join(ws, dir));
    publish('svc-a defines held-credential differently', (seed) => extend(seed, 'mcp', 'svc-a', 'servers', [server('https://other.example.com/mcp')]));

    const result = await run(['pull'], ws);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('mcp: server "held-credential" differs between');
    expect((claudeLocalServer('held-credential') as { headers?: Record<string, string> } | undefined)?.headers?.['X-Test']).toBe('short');
    expect(projectFileServer('held-credential')).toBeUndefined();
    expect(fs.statSync(userFile).mode & 0o777).toBe(0o600);
  });

  it('keeps a held MCP server in .mcp.json, with its record, when the member has their own of that name in Claude\'s local scope', async () => {
    const parked = path.join(sandbox, 'parked-blocked');
    fs.mkdirSync(parked, { recursive: true });
    const children = ['svc-a', 'backend'].filter((dir) => fs.existsSync(path.join(ws, dir)));
    for (const dir of children) fs.renameSync(path.join(ws, dir), path.join(parked, dir));
    publish('platform defines held-blocked', (seed) =>
      extend(seed, 'mcp', 'platform', 'servers', [{ name: 'held-blocked', transport: 'http', url: 'https://blocked.example.com/mcp' }]));
    const alone = await run(['pull'], ws);
    expect(alone.code, alone.output).toBe(0);
    expect(projectFileServer('held-blocked')?.url).toBe('https://blocked.example.com/mcp');
    const userFile = path.join(home, '.claude.json');
    const user = JSON.parse(fs.readFileSync(userFile, 'utf8'));
    user.projects ??= {};
    user.projects[ws] ??= {};
    user.projects[ws].mcpServers = { ...user.projects[ws].mcpServers, 'held-blocked': { type: 'http', url: 'https://member.example.com/mcp' } };
    fs.writeFileSync(userFile, JSON.stringify(user, null, 2));
    for (const dir of children) fs.renameSync(path.join(parked, dir), path.join(ws, dir));
    publish('svc-a defines held-blocked differently', (seed) =>
      extend(seed, 'mcp', 'svc-a', 'servers', [{ name: 'held-blocked', transport: 'http', url: 'https://other.example.com/mcp' }]));

    const result = await run(['pull'], ws);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('mcp: server "held-blocked" differs between');
    expect(claudeLocalServer('held-blocked')?.url).toBe('https://member.example.com/mcp');
    expect(projectFileServer('held-blocked')?.url).toBe('https://blocked.example.com/mcp');
    const recorded = mcpManifests(dataHome()).flatMap((file) =>
      Object.values(JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, Array<{ name: string }>>).flat().map((record) => record.name));
    expect(recorded).toContain('held-blocked');
  });

  it('adopts an equal copy of a held MCP server already in Claude\'s local scope, with the credential it resolved', async () => {
    const parked = path.join(sandbox, 'parked-equal');
    fs.mkdirSync(parked, { recursive: true });
    const children = ['svc-a', 'backend'].filter((dir) => fs.existsSync(path.join(ws, dir)));
    for (const dir of children) fs.renameSync(path.join(ws, dir), path.join(parked, dir));
    publish('platform defines held-equal, with a header from EQUAL_TOKEN', (seed) => {
      extend(seed, 'mcp', 'platform', 'servers', [{ name: 'held-equal', transport: 'http', url: 'https://equal.example.com/mcp', headers: { 'X-Test': '${EQUAL_TOKEN}' } }]);
      extend(seed, 'env', 'platform', 'variables', [{ key: 'EQUAL_TOKEN', value: 'short' }]);
    });
    const alone = await run(['pull'], ws);
    expect(alone.code, alone.output).toBe(0);
    const installed = JSON.parse(fs.readFileSync(path.join(ws, '.mcp.json'), 'utf8')).mcpServers['held-equal'];
    expect(installed.headers['X-Test']).toBe('short');
    const userFile = path.join(home, '.claude.json');
    const user = JSON.parse(fs.readFileSync(userFile, 'utf8'));
    user.projects[ws].mcpServers['held-equal'] = installed;
    fs.writeFileSync(userFile, JSON.stringify(user, null, 2));
    fs.chmodSync(userFile, 0o644);
    for (const dir of children) fs.renameSync(path.join(parked, dir), path.join(ws, dir));
    publish('svc-a defines held-equal differently', (seed) =>
      extend(seed, 'mcp', 'svc-a', 'servers', [{ name: 'held-equal', transport: 'http', url: 'https://other.example.com/mcp' }]));

    const result = await run(['pull'], ws);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('mcp: server "held-equal" differs between');
    expect((claudeLocalServer('held-equal') as { headers?: Record<string, string> } | undefined)?.headers?.['X-Test']).toBe('short');
    expect(projectFileServer('held-equal')).toBeUndefined();
    expect(fs.statSync(userFile).mode & 0o777).toBe(0o600);
    const local: Record<string, Array<{ name: string; resolved?: boolean }>> = JSON.parse(fs.readFileSync(path.join(dataHome(), 'managed-local-mcp.json'), 'utf8'));
    expect(Object.values(local).flat().find((record) => record.name === 'held-equal')?.resolved).toBe(true);
  });

  it('keeps a held MCP server whose record was lost in .mcp.json, which Claude leaves for its local scope', async () => {
    const parked = path.join(sandbox, 'parked-lost');
    fs.mkdirSync(parked, { recursive: true });
    const children = ['svc-a', 'backend'].filter((dir) => fs.existsSync(path.join(ws, dir)));
    for (const dir of children) fs.renameSync(path.join(ws, dir), path.join(parked, dir));
    publish('platform defines held-lost', (seed) =>
      extend(seed, 'mcp', 'platform', 'servers', [{ name: 'held-lost', transport: 'http', url: 'https://lost.example.com/mcp' }]));
    const alone = await run(['pull'], ws);
    expect(alone.code, alone.output).toBe(0);
    expect(projectFileServer('held-lost')?.url).toBe('https://lost.example.com/mcp');
    let lost = 0;
    for (const file of mcpManifests(dataHome())) {
      const manifest: Record<string, Array<{ name: string }>> = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [key, records] of Object.entries(manifest)) {
        manifest[key] = records.filter((record) => record.name !== 'held-lost');
        lost += records.length - manifest[key]!.length;
      }
      fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
    }
    expect(lost).toBeGreaterThan(0);
    for (const dir of children) fs.renameSync(path.join(parked, dir), path.join(ws, dir));
    publish('svc-a defines held-lost differently', (seed) =>
      extend(seed, 'mcp', 'svc-a', 'servers', [{ name: 'held-lost', transport: 'http', url: 'https://other.example.com/mcp' }]));

    const result = await run(['pull'], ws);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('mcp: server "held-lost" differs between');
    expect(projectFileServer('held-lost')?.url).toBe('https://lost.example.com/mcp');
  });

  it('moves a held MCP server to the file OpenCode reads it from now, as installed', async () => {
    // OpenCode V2 in HOME: once sharing.gitExclude is on, its servers go to .opencode/teamai-mcp.json.
    const bin = path.join(sandbox, 'opencode-bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'opencode'), '#!/bin/sh\necho "opencode v2.0.24"\n', { mode: 0o755 });
    cliEnv = { ...cliEnv, PATH: `${bin}${path.delimiter}${cliEnv.PATH}` };
    fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
    fs.mkdirSync(path.join(ws, '.opencode'), { recursive: true });
    git(['init', '-q', '-b', 'main'], ws);
    const configFile = path.join(ws, '.teamai', 'config.yaml');
    const config = YAML.parse(fs.readFileSync(configFile, 'utf8'));
    fs.writeFileSync(configFile, YAML.stringify({ ...config, enabledAgents: [...config.enabledAgents, 'opencode'] }));
    const opencodeServer = (rel: string): { url?: string } | undefined => {
      const file = path.join(ws, rel);
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).mcp?.['moving-api'] : undefined;
    };
    const server = (seed: string, namespace: string, url: string): void => {
      writeEntries(seed, 'mcp', namespace, { servers: [{ name: 'moving-api', transport: 'http', url }] });
    };
    publish('svc-a defines moving-api', (seed) => server(seed, 'svc-a', 'https://moving-first.example.com/mcp'));
    expect((await run(['pull'], ws)).code).toBe(0);
    expect(opencodeServer('opencode.json')?.url).toBe('https://moving-first.example.com/mcp');
    publish('platform defines moving-api differently, and the team keeps delivered files out of git', (seed) => {
      server(seed, 'platform', 'https://moving-second.example.com/mcp');
      fs.appendFileSync(path.join(seed, 'teamai.yaml'), 'sharing:\n  gitExclude:\n    enabled: true\n');
    });

    const result = await run(['pull'], ws);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('mcp: server "moving-api" differs between');
    expect(opencodeServer('.opencode/teamai-mcp.json')?.url).toBe('https://moving-first.example.com/mcp');
    expect(opencodeServer('opencode.json')).toBeUndefined();
  });

  it('keeps a held MCP server whose record was lost in the file OpenCode leaves', async () => {
    // moving-api is held, in .opencode/teamai-mcp.json since the case above.
    const opencodeServer = (rel: string): { url?: string } | undefined => {
      const file = path.join(ws, rel);
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).mcp?.['moving-api'] : undefined;
    };
    expect(opencodeServer('.opencode/teamai-mcp.json')?.url).toBe('https://moving-first.example.com/mcp');
    // Its record is lost: no managed-mcp.json names it any more.
    let lost = 0;
    for (const file of mcpManifests(dataHome())) {
      const manifest: Record<string, Array<{ name: string }>> = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [key, records] of Object.entries(manifest)) {
        manifest[key] = records.filter((record) => record.name !== 'moving-api');
        lost += records.length - manifest[key]!.length;
      }
      fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
    }
    expect(lost).toBeGreaterThan(0);
    const teamYaml = path.join(sandbox, 'seed-team', 'teamai.yaml');
    publish('the team lets git see delivered files again', () =>
      fs.writeFileSync(teamYaml, fs.readFileSync(teamYaml, 'utf8').replace('sharing:\n  gitExclude:\n    enabled: true\n', '')));

    const result = await run(['pull'], ws);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('mcp: server "moving-api" differs between');
    expect(opencodeServer('.opencode/teamai-mcp.json')?.url).toBe('https://moving-first.example.com/mcp');
  });

  it('keeps a held Cursor hook whose command runs teamai', async () => {
    const command = 'echo before && teamai env exec -- node check.js';
    const hook = (seed: string, namespace: string, run: string): void => {
      writeEntries(seed, 'hooks', namespace, { hooks: [{ id: 'marked-hook', description: 'fixture', event: 'Stop', command: run, tools: ['cursor'] }] });
    };
    publish('platform defines marked-hook, which runs teamai', (seed) => hook(seed, 'platform', command));
    expect((await run(['pull'], ws)).code).toBe(0);
    expect(cursorCommand('teamai env exec')).toBeDefined();
    publish('svc-a defines marked-hook differently', (seed) => hook(seed, 'svc-a', 'echo other-marked'));

    const result = await run(['pull'], ws);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('hooks: hook "marked-hook" differs between');
    expect(cursorCommand('teamai env exec')).toBeDefined();
    expect(cursorCommand('other-marked')).toBeUndefined();
  });

  it('keeps a held hook in DeepSeek Harness\'s bridge', async () => {
    fs.mkdirSync(path.join(home, '.dsh'), { recursive: true });
    const configFile = path.join(dataHome(), 'config.yaml');
    const config = YAML.parse(fs.readFileSync(configFile, 'utf8'));
    fs.writeFileSync(configFile, YAML.stringify({ ...config, enabledAgents: [...config.enabledAgents, 'dsh'] }));
    const bridge = (): string => fs.readFileSync(path.join(home, '.teamai', 'dsh', 'hooks.json'), 'utf8');
    const hook = (seed: string, namespace: string, run: string): void => {
      writeEntries(seed, 'hooks', namespace, { hooks: [{ id: 'bridge-hook', description: 'fixture', event: 'Stop', command: run, tools: ['dsh'] }] });
    };
    publish('platform defines bridge-hook', (seed) => hook(seed, 'platform', 'echo prior-dsh'));
    expect((await run(['pull'], ws)).code).toBe(0);
    expect(bridge()).toContain('echo prior-dsh');
    publish('svc-a defines bridge-hook differently', (seed) => hook(seed, 'svc-a', 'echo other-dsh'));

    const result = await run(['pull'], ws);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('hooks: hook "bridge-hook" differs between');
    expect(bridge()).toContain('echo prior-dsh');
    expect(bridge()).not.toContain('echo other-dsh');
  });

  it('moves a held MCP server back to .mcp.json with the credential it resolved, once Muse Code reads the servers there', async () => {
    publish('platform defines held-return, with a header from RETURN_TOKEN', (seed) => {
      extend(seed, 'mcp', 'platform', 'servers', [{ name: 'held-return', transport: 'http', url: 'https://return.example.com/mcp', headers: { 'X-Test': '${RETURN_TOKEN}' } }]);
      extend(seed, 'env', 'platform', 'variables', [{ key: 'RETURN_TOKEN', value: 'short' }]);
    });
    const first = await run(['pull'], ws);
    expect(first.code, first.output).toBe(0);
    expect(claudeLocalServer('held-return')?.url).toBe('https://return.example.com/mcp');
    publish('svc-a defines held-return differently', (seed) =>
      extend(seed, 'mcp', 'svc-a', 'servers', [{ name: 'held-return', transport: 'http', url: 'https://other.example.com/mcp' }]));
    expect((await run(['pull'], ws)).output).toContain('mcp: server "held-return" differs between');
    // Muse Code reads only <root>/.mcp.json, so the workspace's servers go back there.
    fs.mkdirSync(path.join(home, '.config', 'muse'), { recursive: true });
    const configFile = path.join(dataHome(), 'config.yaml');
    const config = YAML.parse(fs.readFileSync(configFile, 'utf8'));
    fs.writeFileSync(configFile, YAML.stringify({ ...config, enabledAgents: [...config.enabledAgents, 'muse'] }));
    // A file readable by others: the move must tighten it, as a delivery of a resolved value does.
    const tree = path.join(ws, '.mcp.json');
    if (!fs.existsSync(tree)) fs.writeFileSync(tree, '{ "mcpServers": {} }\n');
    fs.chmodSync(tree, 0o644);

    const result = await run(['pull'], ws);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('mcp: server "held-return" differs between');
    // Muse Code moved them, not git exclude.
    expect(result.output).not.toContain('sharing.gitExclude off');
    expect(projectFileServer('team-db')).toBeDefined();
    expect((projectFileServer('held-return') as { headers?: Record<string, string> } | undefined)?.headers?.['X-Test']).toBe('short');
    expect(claudeLocalServer('held-return')).toBeUndefined();
    expect(fs.statSync(tree).mode & 0o777).toBe(0o600);
    const records = mcpManifests(dataHome()).flatMap((file) =>
      Object.values(JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, Array<{ name: string; resolved?: boolean }>>).flat());
    expect(records.find((record) => record.name === 'held-return')?.resolved).toBe(true);
    const local: Record<string, Array<{ name: string }>> = JSON.parse(fs.readFileSync(path.join(dataHome(), 'managed-local-mcp.json'), 'utf8'));
    expect(Object.values(local).flat().map((record) => record.name)).not.toContain('held-return');
  });

  it('keeps a held MCP server in Claude\'s local scope, with its record, when the member has their own of that name in .mcp.json', async () => {
    const configFile = path.join(dataHome(), 'config.yaml');
    const setMuse = (on: boolean): void => {
      const config = YAML.parse(fs.readFileSync(configFile, 'utf8'));
      const others = (config.enabledAgents as string[]).filter((agent) => agent !== 'muse');
      fs.writeFileSync(configFile, YAML.stringify({ ...config, enabledAgents: on ? [...others, 'muse'] : others }));
    };
    setMuse(false);
    publish('platform defines held-stuck', (seed) =>
      extend(seed, 'mcp', 'platform', 'servers', [{ name: 'held-stuck', transport: 'http', url: 'https://stuck.example.com/mcp' }]));
    const first = await run(['pull'], ws);
    expect(first.code, first.output).toBe(0);
    expect(claudeLocalServer('held-stuck')?.url).toBe('https://stuck.example.com/mcp');
    publish('svc-a defines held-stuck differently', (seed) =>
      extend(seed, 'mcp', 'svc-a', 'servers', [{ name: 'held-stuck', transport: 'http', url: 'https://other.example.com/mcp' }]));
    expect((await run(['pull'], ws)).output).toContain('mcp: server "held-stuck" differs between');
    const tree = path.join(ws, '.mcp.json');
    const project = fs.existsSync(tree) ? JSON.parse(fs.readFileSync(tree, 'utf8')) : {};
    project.mcpServers = { ...project.mcpServers, 'held-stuck': { type: 'http', url: 'https://member.example.com/mcp' } };
    fs.writeFileSync(tree, JSON.stringify(project, null, 2));
    setMuse(true);

    const result = await run(['pull'], ws);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('mcp: server "held-stuck" differs between');
    expect(projectFileServer('team-db')).toBeDefined();
    expect(projectFileServer('held-stuck')?.url).toBe('https://member.example.com/mcp');
    expect(claudeLocalServer('held-stuck')?.url).toBe('https://stuck.example.com/mcp');
    const local: Record<string, Array<{ name: string }>> = JSON.parse(fs.readFileSync(path.join(dataHome(), 'managed-local-mcp.json'), 'utf8'));
    expect(Object.values(local).flat().map((record) => record.name)).toContain('held-stuck');
  });
});
