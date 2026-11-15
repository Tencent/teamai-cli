/**
 * E2E (#1885): every `--json` command keeps stdout to the JSON alone. Loading
 * the team config warns when a roles manifest does not parse, and that warning
 * used to land on stdout ahead of the JSON, so a hook or CI parsing the whole
 * stream failed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForDetachedChildren } from '../helpers/detached-processes.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dist', 'index.js');
const WARNING = 'Invalid roles manifest';
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};

let sandbox: string;

beforeAll(() => {
  if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
  sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-json-stdout-1885-')));
});

afterAll(async () => {
  await waitForDetachedChildren();
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

function run(args: string[], cwd: string, home: string): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...GIT_ENV,
      HOME: home,
      USERPROFILE: home,
      GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      TEAMAI_NONINTERACTIVE: '1',
    },
  });

  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('a roles manifest that does not parse keeps every --json command parseable (#1885)', () => {
  let project: string;
  let home: string;

  beforeAll(() => {
    home = path.join(sandbox, 'home');
    project = path.join(sandbox, 'project');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(home, '.gitconfig'), `[user]\n\tname = TeamAI CI\n\temail = ci@teamai.test\n`);
    // Self mode reads the business repo's own `origin` remote.
    spawnSync('git', ['init', '-q', '.'], { cwd: project, env: { ...process.env, ...GIT_ENV } });
    spawnSync('git', ['remote', 'add', 'origin', 'https://example.test/acme/business.git'], { cwd: project, env: { ...process.env, ...GIT_ENV } });

    run(['init', '--self', '--agent', 'claude', '--provider', 'git'], project, home);
    // The team repo of a self-mode project is its own .teamai/.
    fs.mkdirSync(path.join(project, '.teamai', 'manifest'), { recursive: true });
    fs.writeFileSync(path.join(project, '.teamai', 'manifest', 'roles.yaml'), 'roles: 5\n');
  });

  it.each([
    ['list'],
    ['digest'],
    ['codebase', '--lint'],
  ])('%s --json puts the JSON on stdout and the warning on stderr', (...args: string[]) => {
    const { stdout, stderr } = run([...args, '--json'], project, home);

    // The JSON may quote the manifest's error as data; the contract is that the
    // stream is the JSON alone, so a first-character check catches a warning
    // printed ahead of it even when the same text legitimately appears inside.
    expect(stdout.trimStart()[0]).toBe('{');
    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(stderr).toContain(WARNING);
  });

  it('doctor --json writes a report that reports the manifest, instead of nothing', () => {
    const { code, stdout, stderr } = run(['doctor', '--json'], project, home);

    const report = JSON.parse(stdout) as { ok: boolean; checks: Array<{ ok: boolean; name: string; fix?: string }> };

    expect(report.ok).toBe(false);
    expect(report.checks.some((c) => !c.ok && c.fix?.includes(WARNING))).toBe(true);
    expect(stderr).toContain(WARNING);
    expect(code).toBe(1);
  });
});
