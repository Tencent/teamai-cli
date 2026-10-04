import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const cli = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
let sandbox: string;
let home: string;
let project: string;
let origin: string;
let clone: string;
let configPath: string;
let note: string;
let env: NodeJS.ProcessEnv;

function git(args: string[], cwd = sandbox): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function run(args: string[]) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: project, env, encoding: 'utf8', timeout: 30_000,
  });
  if (result.error) throw result.error;
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

function writeYaml(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, YAML.stringify(value));
}

function setProjects(projects: string[]): void {
  const config = YAML.parse(fs.readFileSync(configPath, 'utf8'));
  writeYaml(configPath, { ...config, projects });
}

// Includes directory creation as well as byte changes, including the queue,
// index, config, locks and git refs in this isolated machine.
function snapshot(dir = sandbox, ignoreDebugLog = false): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    const relative = path.relative(sandbox, file);
    // Real command errors use the ordinary diagnostic log; it is not a learning write.
    if (ignoreDebugLog && file === path.join(home, '.teamai', 'debug.log')) return [];
    return entry.isDirectory()
      ? [`${relative}/`, ...snapshot(file, ignoreDebugLog)]
      : [`${relative}:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`];
  });
}

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-namespace-e2e-'));
  home = path.join(sandbox, 'home');
  project = path.join(sandbox, 'project');
  origin = path.join(sandbox, 'origin.git');
  clone = path.join(project, '.teamai', 'team-repo');
  configPath = path.join(project, '.teamai', 'config.yaml');
  const seed = path.join(sandbox, 'seed');
  fs.mkdirSync(path.join(home, '.teamai'), { recursive: true });
  fs.mkdirSync(seed);
  fs.mkdirSync(project);
  env = {
    ...process.env,
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'member', GIT_AUTHOR_EMAIL: 'member@example.invalid',
    GIT_COMMITTER_NAME: 'member', GIT_COMMITTER_EMAIL: 'member@example.invalid',
    GIT_TERMINAL_PROMPT: '0', FORCE_COLOR: '0',
  };
  writeYaml(path.join(seed, 'teamai.yaml'), {
    team: 'namespace-fixture', repo: origin, provider: 'git', usageReport: false,
  });
  writeYaml(path.join(seed, 'manifest', 'projects.yaml'), {
    version: 1,
    projects: [
      { id: 'svc-a', resources: { learnings: ['svc-a', 'payments'] } },
      { id: 'alpha', resources: { learnings: ['alpha-notes'] } },
    ],
  });
  git(['init', '-q', '-b', 'main'], seed);
  git(['add', '.'], seed);
  git(['commit', '-qm', 'fixture'], seed);
  git(['clone', '-q', '--bare', seed, origin]);
  git(['clone', '-q', origin, clone]);
  writeYaml(configPath, {
    repo: { localPath: clone, remote: origin, kind: 'git' },
    username: 'member', scope: 'project', projectRoot: project,
    updatePolicy: 'skip', additionalRoles: [], projects: ['svc-a'], enabledAgents: ['claude'],
  });
  note = path.join(sandbox, 'note.md');
  fs.writeFileSync(note, '# Narwhal contract\n\nNarwhal payments require a stable retry key.\n');
});

afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }));

describe('contribute --namespace through the built CLI (#916)', () => {
  it('publishes to the chosen namespace and immediately recalls the published file', () => {
    const result = run(['contribute', '--file', note, '--title', 'narwhal', '--namespace', 'payments']);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('Contributed: learnings/payments/narwhal-');
    const files = git(['ls-tree', '-r', '--name-only', 'teamai-learnings'], origin).split('\n');
    expect(files.filter((f) => f.endsWith('.md'))).toEqual([expect.stringMatching(/^learnings\/payments\/narwhal-/)]);
    const recalled = run(['recall', 'narwhal']);
    expect(recalled.code, recalled.output).toBe(0);
    const file = recalled.output.match(/^File: (.+)$/m)?.[1];
    expect(file, recalled.output).toBeDefined();
    expect(file).toContain(`${path.sep}payments${path.sep}`);
    expect(fs.readFileSync(file!, 'utf8')).toContain('stable retry key');
    expect(file).not.toContain('pending-learnings');
  });

  it.each([
    { projects: ['svc-a'], destination: 'learnings/ (shared root)', allowed: 'svc-a, payments', prefix: 'learnings/narwhal-' },
    { projects: ['alpha'], destination: 'learnings/alpha-notes/', allowed: 'alpha-notes', prefix: 'learnings/alpha-notes/narwhal-' },
    { projects: [], destination: 'learnings/ (shared root)', allowed: '(none)', prefix: 'learnings/narwhal-' },
  ])('preserves the default and lists its choices for $projects', ({ projects, destination, allowed, prefix }) => {
    setProjects(projects);
    const before = snapshot();
    const listed = run(['projects', 'list']);
    expect(listed.code, listed.output).toBe(0);
    expect(listed.output).toContain(`Contributes to: ${destination}   --namespace accepts: ${allowed}`);
    expect(snapshot()).toEqual(before);
    const result = run(['contribute', '--file', note, '--title', 'narwhal']);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain(`Contributed: ${prefix}`);
    expect(git(['ls-tree', '-r', '--name-only', 'teamai-learnings'], origin)).toContain(prefix);
    if (projects[0] === 'svc-a') expect(result.output).toContain('pass --namespace <ns>: svc-a, payments');
  });

  it.each(['project', 'user'])('previews the selected %s namespace without filesystem writes', (scope) => {
    if (scope === 'user') {
      const config = YAML.parse(fs.readFileSync(configPath, 'utf8'));
      writeYaml(path.join(home, '.teamai', 'config.yaml'), { ...config, scope: 'user', projectRoot: undefined });
      setProjects(['alpha']); // An explicit user scope must not use this project's choices.
    }
    const before = snapshot();
    const result = run(['contribute', '--scope', scope, '--file', note, '--namespace', 'payments', '--dry-run']);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('[dry-run] Would push: learnings/payments/');
    expect(snapshot()).toEqual(before);
  });

  it.each(['alpha-notes', '../escape', 'a/b', 'a\\b', ''])('rejects the unavailable namespace %j before writing', (namespace) => {
    const before = snapshot(sandbox, true);
    const result = run(['contribute', '--file', note, '--namespace', namespace]);
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('Allowed learnings namespaces: svc-a, payments');
    expect(snapshot(sandbox, true)).toEqual(before);
  });

  it('keeps a team without a projects manifest at the shared root and rejects explicit namespaces', () => {
    fs.rmSync(path.join(clone, 'manifest', 'projects.yaml'));
    const before = snapshot(sandbox, true);
    expect(run(['projects', 'list']).output).toContain('Contributes to: learnings/ (shared root)   --namespace accepts: (none)');
    const result = run(['contribute', '--file', note, '--namespace', 'payments']);
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('Allowed learnings namespaces: (none)');
    const preview = run(['contribute', '--file', note, '--title', 'narwhal', '--dry-run']);
    expect(preview.code, preview.output).toBe(0);
    expect(preview.output).toContain('Would push: learnings/narwhal-');
    expect(snapshot(sandbox, true)).toEqual(before);
  });

  it('retains the chosen namespace in the offline queue when a later contribution publishes it', () => {
    fs.renameSync(origin, `${origin}.offline`);
    const queued = run(['contribute', '--file', note, '--title', 'narwhal', '--namespace', 'payments']);
    expect(queued.code, queued.output).toBe(0);
    expect(queued.output).toContain('Saved locally');
    const pending = path.join(project, '.teamai', 'pending-learnings', 'payments');
    expect(fs.readdirSync(pending).some((file) => file.startsWith('narwhal-'))).toBe(true);
    fs.renameSync(`${origin}.offline`, origin);
    const retry = run(['contribute', '--file', note, '--title', 'shared']);
    expect(retry.code, retry.output).toBe(0);
    expect(retry.output).toContain('Contributed: learnings/shared-');
    const files = git(['ls-tree', '-r', '--name-only', 'teamai-learnings'], origin);
    expect(files).toContain('learnings/payments/narwhal-');
    expect(files).toContain('learnings/shared-');
  });
});
