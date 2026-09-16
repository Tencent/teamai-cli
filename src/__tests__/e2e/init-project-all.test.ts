import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

// ─── init --project all e2e (issue #509) ────────────────────────────────────
//
// The unit suite in `init-projects.test.ts` drives `resolveActiveProjects`
// directly. This is the end-to-end leg for the user-facing command, run through
// the ACTUAL compiled CLI: `teamai init <repo> --project all` must resolve the
// selector against the manifest it just cloned and persist every id.
//
// The remote has to be a URL the provider accepts — init rejects plain HTTP
// outright ("plain HTTP is not supported; use HTTPS or SSH") — while never
// touching the network. git's own `url.<base>.insteadOf` does the bridging: the
// CLI validates a synthetic HTTPS URL, and git rewrites it to a local bare repo.
// The rewrite target is a plain filesystem path, not `file:///C:/…`: on Git for
// Windows the latter parses as `/C:/…` and the clone fails.
//
// For clone-reuse scenarios we also install a test-only `git` wrapper ahead of
// PATH that returns the synthetic HTTPS origin for `remote get-url`. Real git's
// `insteadOf` expansion would otherwise make remotesMatch treat the clone as a
// different repository and force a replace/reclone path.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const FAKE_URL = 'https://git.example.com/team/team.git';

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

function readProjects(projectRoot: string): string[] {
  const configPath = path.join(projectRoot, '.teamai', 'config.yaml');
  const config = YAML.parse(fs.readFileSync(configPath, 'utf8')) as { projects?: string[] };
  return config.projects ?? [];
}

function readClonePath(projectRoot: string): string {
  const configPath = path.join(projectRoot, '.teamai', 'config.yaml');
  const config = YAML.parse(fs.readFileSync(configPath, 'utf8')) as {
    repo?: { localPath?: string };
  };
  const localPath = config.repo?.localPath;
  if (!localPath) {
    throw new Error(`Missing repo.localPath in ${configPath}`);
  }
  return localPath;
}

function installGitRemoteGetUrlWrapper(binDir: string, syntheticOrigin: string): string {
  fs.mkdirSync(binDir, { recursive: true });
  const wrapper = path.join(binDir, 'git');
  // Resolve the real git once so the wrapper never re-invokes itself.
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(
    wrapper,
    `#!/bin/sh
# Test-only: keep remotesMatch on the synthetic HTTPS origin while insteadOf
# still rewrites network ops to the local bare remote.
if [ "$1" = "remote" ] && [ "$2" = "get-url" ]; then
  case "$3" in
    ""|origin|--all)
      printf '%s\\n' '${syntheticOrigin.replace(/'/g, `'\"'\"'`)}'
      exit 0
      ;;
  esac
fi
exec '${realGit.replace(/'/g, `'\"'\"'`)}' "$@"
`,
    { mode: 0o755 },
  );
  return binDir;
}

function runCLI(
  args: string[],
  cwd: string,
  home: string,
  extraEnv: Record<string, string> = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn('node', [CLI, ...args], {
      cwd,
      env: {
        ...process.env,
        ...GIT_ENV,
        HOME: home,
        USERPROFILE: home,
        FORCE_COLOR: '0',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
    child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
    child.on('close', (code) => resolve({ code, output }));
  });
}

describe("init --project all activates every project in the manifest (issue #509)", () => {
  let sandbox: string;
  let home: string;
  let projectRoot: string;
  let remote: string;
  let gitWrapperBin: string;
  let cliEnv: Record<string, string>;

  beforeAll(() => {
    if (!fs.existsSync(CLI)) {
      throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
    }

    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-init-all-e2e-'));
    home = path.join(sandbox, 'home');
    projectRoot = path.join(sandbox, 'project');
    const seed = path.join(sandbox, 'seed');
    remote = path.join(sandbox, 'team.git');
    gitWrapperBin = path.join(sandbox, 'bin');

    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(path.join(seed, 'manifest'), { recursive: true });

    // Intentionally NOT a git repo: project-scope init then keeps dataHome at
    // `<projectRoot>/.teamai` (a git workspace would partition under ~/.teamai/projects/...).

    fs.writeFileSync(path.join(seed, 'teamai.yaml'), [
      'team: init-all-e2e',
      `repo: ${FAKE_URL}`,
      'provider: git',
      'reviewers: []',
      'toolPaths:',
      '  claude:',
      '    skills: .claude/skills',
      '',
    ].join('\n'));

    // Three projects, deliberately NOT in alphabetical order: the expansion must
    // follow the manifest's own order, not sort.
    fs.writeFileSync(path.join(seed, 'manifest', 'projects.yaml'), [
      'version: 1',
      'projects:',
      '  - id: gamma',
      '    name: Gamma',
      '    resources:',
      '      skills: [gamma]',
      '  - id: alpha',
      '    name: Alpha',
      '    resources:',
      '      skills: [alpha]',
      '  - id: billing',
      '    name: Billing',
      '    resources:',
      '      skills: [billing]',
      '',
    ].join('\n'));

    fs.writeFileSync(path.join(seed, 'manifest', 'roles.yaml'), [
      'version: 1',
      'roles:',
      '  - id: common',
      '    description: All namespaces',
      '    resources:',
      '      knowledge: []',
      '      skills: [gamma, alpha, billing]',
      '',
    ].join('\n'));

    for (const ns of ['gamma', 'alpha', 'billing']) {
      const dir = path.join(seed, 'skills', ns, `${ns}-only`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'SKILL.md'),
        `---\nname: ${ns}-only\ndescription: ${ns} fixture\n---\n\n# ${ns}\n`,
      );
    }

    git(['init', '-q', '-b', 'main'], seed);
    git(['add', '-A'], seed);
    git(['commit', '-q', '-m', 'seed'], seed);
    git(['clone', '-q', '--bare', seed, remote], sandbox);

    // Bridge the synthetic HTTPS remote to the local bare repo, in the sandbox
    // HOME so the real one is never touched.
    git(['config', '--global', `url.${remote}.insteadOf`, FAKE_URL], sandbox, home);

    installGitRemoteGetUrlWrapper(gitWrapperBin, FAKE_URL);
    cliEnv = {
      PATH: `${gitWrapperBin}${path.delimiter}${process.env.PATH ?? ''}`,
    };
  });

  afterAll(() => {
    if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it("expands `all` to every id in the cloned manifest, in manifest order", async () => {
    const result = await runCLI(
      ['init', FAKE_URL, '--scope', 'project', '--role', 'common', '--project', 'all', '--force'],
      projectRoot,
      home,
      cliEnv,
    );
    expect(result.code, result.output).toBe(0);
    expect(readProjects(projectRoot)).toEqual(['gamma', 'alpha', 'billing']);
  }, 60_000);

  it('still round-trips an explicit id (the selector did not change)', async () => {
    const result = await runCLI(
      ['init', FAKE_URL, '--scope', 'project', '--role', 'common', '--project', 'billing', '--force'],
      projectRoot,
      home,
      cliEnv,
    );
    expect(result.code, result.output).toBe(0);
    // `--project` overwrites: an explicit id must NOT leave the previous `all`
    // expansion behind.
    expect(readProjects(projectRoot)).toEqual(['billing']);
  }, 60_000);

  it('reuses the clone but refreshes so a newly added remote project is activated', async () => {
    const first = await runCLI(
      ['init', FAKE_URL, '--scope', 'project', '--role', 'common', '--project', 'all', '--force'],
      projectRoot,
      home,
      cliEnv,
    );
    expect(first.code, first.output).toBe(0);
    expect(readProjects(projectRoot)).toEqual(['gamma', 'alpha', 'billing']);

    const teamRepo = readClonePath(projectRoot);
    expect(fs.existsSync(path.join(teamRepo, '.git'))).toBe(true);
    // Project scope stores the clone under the project dataHome, not ~/.teamai.
    // realpathSync both sides: macOS aliases /var to /private/var, which
    // path.resolve() alone does not reconcile.
    expect(fs.realpathSync(teamRepo)).toBe(
      fs.realpathSync(path.join(projectRoot, '.teamai', 'team-repo')),
    );

    // Point push at the bare remote so pull can see upcoming updates without a
    // network; keep origin URL as the synthetic HTTPS (wrapper reinforces this).
    git(['remote', 'set-url', 'origin', FAKE_URL], teamRepo);
    git(['remote', 'set-url', '--add', '--push', 'origin', remote], teamRepo);

    // Add a fourth project on the remote and push it.
    const update = path.join(sandbox, 'update-work');
    if (fs.existsSync(update)) fs.rmSync(update, { recursive: true, force: true });
    git(['clone', '-q', remote, update], sandbox);
    const manifestPath = path.join(update, 'manifest', 'projects.yaml');
    let manifest = fs.readFileSync(manifestPath, 'utf8');
    if (!manifest.includes('id: delta')) {
      manifest = manifest.trimEnd() + [
        '',
        '  - id: delta',
        '    name: Delta',
        '    resources:',
        '      skills: [delta]',
        '',
      ].join('\n');
      fs.writeFileSync(manifestPath, manifest);
      const deltaSkill = path.join(update, 'skills', 'delta', 'delta-only');
      fs.mkdirSync(deltaSkill, { recursive: true });
      fs.writeFileSync(
        path.join(deltaSkill, 'SKILL.md'),
        '---\nname: delta-only\ndescription: delta fixture\n---\n\n# delta\n',
      );
      git(['add', '-A'], update);
      git(['commit', '-q', '-m', 'add delta project'], update);
      git(['push', '-q', 'origin', 'HEAD'], update);
    }

    const second = await runCLI(
      ['init', FAKE_URL, '--scope', 'project', '--role', 'common', '--project', 'all', '--force'],
      projectRoot,
      home,
      cliEnv,
    );
    expect(second.code, second.output).toBe(0);
    expect(second.output).toMatch(/using existing clone/i);
    expect(readProjects(projectRoot)).toEqual(['gamma', 'alpha', 'billing', 'delta']);
  }, 90_000);

  it('preserves tracked local edits when refresh cannot fast-forward (no hard reset)', async () => {
    // Seed with an explicit project id (reviewer reproduction used --project billing).
    const first = await runCLI(
      ['init', FAKE_URL, '--scope', 'project', '--role', 'common', '--project', 'billing', '--force'],
      projectRoot,
      home,
      cliEnv,
    );
    expect(first.code, first.output).toBe(0);
    expect(readProjects(projectRoot)).toEqual(['billing']);

    const teamRepo = readClonePath(projectRoot);
    git(['remote', 'set-url', 'origin', FAKE_URL], teamRepo);
    git(['remote', 'set-url', '--add', '--push', 'origin', remote], teamRepo);

    // Advance the remote manifest.
    const update = path.join(sandbox, 'update-dirty');
    if (fs.existsSync(update)) fs.rmSync(update, { recursive: true, force: true });
    git(['clone', '-q', remote, update], sandbox);
    const remoteManifest = path.join(update, 'manifest', 'projects.yaml');
    fs.appendFileSync(remoteManifest, '\n# remote-advance-marker\n');
    git(['add', '-A'], update);
    git(['commit', '-q', '-m', 'advance remote manifest'], update);
    git(['push', '-q', 'origin', 'HEAD'], update);

    // Leave a tracked local edit that would be discarded by reset --hard.
    const localManifest = path.join(teamRepo, 'manifest', 'projects.yaml');
    const marker = `\n# local-edit-must-survive-${Date.now()}\n`;
    fs.appendFileSync(localManifest, marker);
    expect(fs.readFileSync(localManifest, 'utf8')).toContain(marker.trim());

    // Drop only the project config so init re-runs without --force while the
    // dedicated clone (and dirty working tree) remain.
    fs.rmSync(path.join(projectRoot, '.teamai', 'config.yaml'), { force: true });

    const second = await runCLI(
      ['init', FAKE_URL, '--scope', 'project', '--role', 'common', '--project', 'billing'],
      projectRoot,
      home,
      cliEnv,
    );

    // Must not hard-reset: local edit survives. Refresh may fail (exit non-zero)
    // because ff-only cannot proceed with a dirty overlapping file — that is OK.
    const after = fs.readFileSync(localManifest, 'utf8');
    expect(after).toContain(marker.trim());
    expect(second.output).not.toMatch(/realigning discards/i);
    if (second.code !== 0) {
      expect(second.output).toMatch(/Failed to refresh existing clone|fast-forward|ff-only|not possible|diverg/i);
    }
  }, 90_000);
});
