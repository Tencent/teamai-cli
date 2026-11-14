import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { getTeamSecretsPath } from '../../secret-store.js';

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
  // The team's skills the selection delivers: teamai's own, the CLI's and those pull generates from workflows, are left out.
  const skillsIn = (root: string): string[] => {
    const dir = path.join(root, '.claude', 'skills');
    return fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((name) => !name.startsWith('teamai') && !name.startsWith('workflow-')).sort()
      : [];
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

  // An older release kept one list, written beside the configured Claude settings file, with `.claude` in its entries.
  it('keeps owning the excludes an older release recorded in a Claude settings folder of the team\'s, and uninstall takes them back', async () => {
    publish('a Claude settings folder of its own', (seed) => {
      fs.writeFileSync(path.join(seed, 'teamai.yaml'), `${fs.readFileSync(path.join(seed, 'teamai.yaml'), 'utf8')}toolPaths:\n  claude:\n    settings: .claude-custom/settings.json\n`);
    });
    const svcB = path.join(ws, 'backend', 'svc-b');
    const settings = path.join(svcB, '.claude-custom', 'settings.local.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    expect((await run(['pull'], svcB)).code).toBe(0);
    const stateFile = fs.readdirSync(path.join(home, '.teamai', 'projects'))
      .map((slug) => path.join(home, '.teamai', 'projects', slug, 'state.json'))
      .find((file) => fs.existsSync(file) && Object.values(JSON.parse(fs.readFileSync(file, 'utf8')).lastPullByWorkspace ?? {}).some((record) => (record as { root?: string }).root === svcB))!;
    const legacy = [path.join(ws, 'CLAUDE.md'), path.join(ws, '.claude', 'CLAUDE.md'), path.join(ws, 'AGENTS.md'), path.join(ws, '.claude', 'rules', '**')];
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    for (const record of Object.values(state.lastPullByWorkspace) as Array<{ root?: string; claudeMdExcludes?: unknown }>) {
      if (record.root === svcB) record.claudeMdExcludes = legacy;
    }
    fs.writeFileSync(stateFile, JSON.stringify(state));
    fs.writeFileSync(settings, JSON.stringify({ claudeMdExcludes: ['/elsewhere/CLAUDE.md', ...legacy] }));

    const pull = await run(['pull', '--force'], svcB);

    expect(pull.code, pull.output).toBe(0);
    const owned = [path.join(ws, 'CLAUDE.md'), path.join(ws, 'AGENTS.md'), path.join(ws, '.claude-custom', 'CLAUDE.md'), path.join(ws, '.claude-custom', 'rules', '**')];
    expect(JSON.parse(fs.readFileSync(settings, 'utf8')).claudeMdExcludes).toEqual(['/elsewhere/CLAUDE.md', ...owned]);

    const uninstall = await run(['uninstall', '--force'], svcB);

    expect(uninstall.code, uninstall.output).toBe(0);
    expect(JSON.parse(fs.readFileSync(settings, 'utf8')).claudeMdExcludes).toEqual(['/elsewhere/CLAUDE.md']);
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

  it('keeps a held Cursor hook whose command runs teamai', async () => {
    const command = 'echo before && teamai env exec -- node check.js';
    const hook = (seed: string, namespace: string, hookCommand: string): void => {
      writeEntries(seed, 'hooks', namespace, { hooks: [{ id: 'marked-hook', description: 'fixture', event: 'Stop', command: hookCommand, tools: ['cursor'] }] });
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
});
