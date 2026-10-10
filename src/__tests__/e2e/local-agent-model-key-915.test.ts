/**
 * E2E (#915): a model API key the HTTP local agent writes to a project's
 * `.codebuddy/models.json` is always kept out of git, whatever the git exclude
 * flag says, through the `credentials` block of the repository's exclude file.
 * The key is never written where git would commit it: a tracked file, or one a
 * rule re-includes, gets no key, and the member is told why and how to fix it.
 * The line goes only once the file is gone; `teamai uninstall` keeps it, with a
 * warning, while the file still holds a key.
 *
 * Runs the built CLI against an in-process mock backend, so the CLI is spawned
 * asynchronously. Each case gets its own HOME and repository.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trackDetachedProcesses } from '../helpers/detached-processes.js';
import { startMockServer, type MockCommand, type MockServerHandle } from '../helpers/mock-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '..', '..', '..', 'dist', 'index.js');
const API_KEY = 'e2e-http-key';
const MODEL_KEY = 'sk-model-key-915';
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
};
const MODELS = '.codebuddy/models.json';

interface Run { code: number | null; output: string }

let sandbox: string;
let detached: ReturnType<typeof trackDetachedProcesses>;
let server: MockServerHandle;
let nextId = 1;

beforeAll(async () => {
  sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-model-key-915-')));
  detached = trackDetachedProcesses(sandbox);
  server = await startMockServer({ apiKey: API_KEY });
});

afterAll(async () => {
  await detached?.waitForExit();
  await server?.close();
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

const model = { provider: 'tokenhub', model_id: 'team-model', name: 'Team Model', base_url: 'https://proxy.example.com/v1', api_key: MODEL_KEY };

function applyModels(workspace: string, models: unknown[] = [model]): MockCommand {
  return { id: nextId++, type: 'apply_model_config', scope: 'workspace', workspace_path: workspace, cmd: JSON.stringify({ models }) };
}

/** A committed repository with teamai initialized in HTTP mode for CodeBuddy, bound to a project of the backend. */
async function machine(name: string, options: { flag?: boolean } = {}) {
  const base = fs.mkdtempSync(path.join(sandbox, `${name}-`));
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  const env: NodeJS.ProcessEnv = {
    ...process.env, ...GIT_ENV, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1', SHELL: '/bin/bash', FORCE_COLOR: '0', TEAMAI_BIND_PROMPT_ENABLED: '0',
    NODE_OPTIONS: [process.env.NODE_OPTIONS, detached.nodeOptions].filter(Boolean).join(' '),
  };
  delete env.CLAUDE_CONFIG_DIR;
  delete env.TEAMAI_API_TOKEN;
  delete env.TEAMAI_API_KEY;
  const git = (args: string[], cwd: string): { code: number | null; out: string } => {
    const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  // Spawned asynchronously: the mock backend runs in this process.
  const cli = (args: string[], cwd: string, input?: string): Promise<Run> => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    child.on('close', (code) => resolve({ code, output }));
    child.stdin.end(input ?? '');
  });

  const root = path.join(base, 'app');
  fs.mkdirSync(path.join(root, '.codebuddy'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), '# app\n');
  git(['init', '-q', '-b', 'main'], root);
  git(['add', '-A'], root);
  git(['commit', '-q', '-m', 'app'], root);
  const project = fs.realpathSync.native(root);
  const init = await cli(['init', '--http', server.url, '--token', API_KEY, '--scope', 'project', '--agent', 'codebuddy', '--force'], project);
  expect(init.code, init.output).toBe(0);
  const configFile = path.join(home, '.teamai', 'local-agent', 'config.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  config.workspaceBindings[project] = { projectId: 7, projectName: 'App', boundAt: '2026-10-08T00:00:00.000Z', ideType: 'codebuddy' };
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  if (options.flag !== undefined) {
    const projects = path.join(home, '.teamai', 'projects');
    const partition = fs.readdirSync(projects).map((d) => path.join(projects, d, 'config.yaml'))
      .find((file) => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(`projectRoot: ${project}\n`));
    if (!partition) throw new Error(`no partition config for ${project}`);
    fs.appendFileSync(partition, `gitExcludeEnabled: ${options.flag}\n`);
  }

  return {
    project,
    home,
    git,
    cli,
    file: (rel: string) => path.join(project, rel),
    /** What `git status` shows under `.codebuddy/`, teamai's own skill copies (flag off) left out. */
    status: (): string[] => git(['status', '--porcelain', '-uall', '--', '.codebuddy'], project).out.split('\n')
      .filter((line) => line && !line.includes('.codebuddy/skills/')),
    ignored: (rel: string): boolean => git(['check-ignore', '-q', rel], project).code === 0,
    /** The lines of the `credentials` block in the project's exclude file, or null without one. */
    credentialLines(): string[] | null {
      const file = path.join(project, '.git', 'info', 'exclude');
      const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      const match = /# \[teamai:credentials:start\]\n([\s\S]*?)# \[teamai:credentials:end\]\n/.exec(content);
      return match ? match[1].split('\n').filter(Boolean) : null;
    },
    /** A CodeBuddy session start whose sync hands back `commands`; the acks they got and the hook's output. */
    async sessionStart(commands: MockCommand[]): Promise<{ acks: Array<{ status: string; error?: string }>; output: string }> {
      const before = server.acks.length;
      server.seedCommands(commands);
      const run = await cli(['hook-dispatch', 'session-start', '--tool', 'codebuddy'], project,
        JSON.stringify({ cwd: project, session_id: `s-${path.basename(base)}`, hook_event_name: 'SessionStart', source: 'startup' }));
      await detached.waitForExit();
      expect(run.code, run.output).toBe(0);
      return { acks: server.acks.slice(before).map(({ body }) => body as { status: string; error?: string }), output: run.output };
    },
  };
}

describe.skipIf(process.platform === 'win32')('a model API key the HTTP local agent writes stays out of git (#915)', () => {
  it.each([
    { flag: undefined, label: 'unset' },
    { flag: true, label: 'on' },
    { flag: false, label: 'off' },
  ])('writes the key into an untracked file git then ignores, with the git exclude flag $label', async ({ flag }) => {
    const m = await machine(`untracked-${String(flag)}`, { flag });
    fs.writeFileSync(m.file('.codebuddy/mine.json'), '{}\n');

    const { acks } = await m.sessionStart([applyModels(m.project)]);

    expect(acks.map((ack) => ack.status), acks[0]?.error).toEqual(['success']);
    expect(fs.readFileSync(m.file(MODELS), 'utf8')).toContain(MODEL_KEY);
    expect(m.ignored(MODELS)).toBe(true);
    expect(m.credentialLines()).toEqual(['/.codebuddy/models.json']);
    // No committable .gitignore of teamai's; the member's own file stays visible and addable.
    expect(fs.existsSync(m.file('.codebuddy/.gitignore'))).toBe(false);
    expect(m.status()).toEqual(['?? .codebuddy/mine.json']);
    expect(m.git(['ls-files', '--others', '--exclude-standard', '--', '.codebuddy/mine.json', MODELS], m.project).out.trim())
      .toBe('.codebuddy/mine.json');
  }, 120_000);

  it('lists the models file in its own block while teamai\'s delivered block already ignores it, so the key stays out of git once the option goes off', async () => {
    const m = await machine('covered', { flag: true });
    const exclude = m.file('.git/info/exclude');
    fs.appendFileSync(exclude, '# [teamai:delivered:start]\n/.codebuddy/models.json\n# [teamai:delivered:end]\n');
    fs.writeFileSync(m.file(MODELS), '{\n  "models": []\n}\n');
    expect(m.ignored(MODELS)).toBe(true);

    const { acks } = await m.sessionStart([applyModels(m.project)]);
    expect(acks.map((ack) => ack.status), acks[0]?.error).toEqual(['success']);
    expect(m.credentialLines()).toEqual(['/.codebuddy/models.json']);

    const projects = path.join(path.dirname(m.project), 'home', '.teamai', 'projects');
    for (const dir of fs.readdirSync(projects)) {
      const config = path.join(projects, dir, 'config.yaml');
      if (fs.existsSync(config)) fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace('gitExcludeEnabled: true', 'gitExcludeEnabled: false'));
    }
    const pull = await m.cli(['pull'], m.project);
    expect(pull.code, pull.output).toBe(0);

    expect(fs.readFileSync(exclude, 'utf8')).not.toContain('# [teamai:delivered:start]');
    expect(fs.readFileSync(m.file(MODELS), 'utf8')).toContain(MODEL_KEY);
    expect(m.ignored(MODELS)).toBe(true);
    expect(m.status()).toEqual([]);
  }, 120_000);

  it('withholds the key from a models file git tracks, and names `git rm --cached`', async () => {
    const m = await machine('tracked');
    const committed = '{\n  "models": []\n}\n';
    fs.writeFileSync(m.file(MODELS), committed);
    m.git(['add', MODELS], m.project);
    m.git(['commit', '-q', '-m', 'models'], m.project);

    const { acks } = await m.sessionStart([applyModels(m.project)]);

    expect(acks.map((ack) => ack.status)).toEqual(['failed']);
    expect(acks[0].error).toContain('withheld the model API key');
    expect(acks[0].error).toContain(`git already tracks ${m.file(MODELS)}`);
    expect(acks[0].error).toContain(`Run \`git rm --cached ${m.file(MODELS)}\` (rotate any value a commit of it holds), then apply the model config again.`);
    expect(fs.readFileSync(m.file(MODELS), 'utf8')).toBe(committed);
    expect(m.status()).toEqual([]);
  }, 120_000);

  it('withholds the key from a models file a .gitignore rule re-includes, and names the rule', async () => {
    const m = await machine('reincluded');
    fs.writeFileSync(m.file('.gitignore'), '!/.codebuddy/models.json\n');
    m.git(['add', '.gitignore'], m.project);
    m.git(['commit', '-q', '-m', 'ignore rules'], m.project);

    const { acks } = await m.sessionStart([applyModels(m.project)]);

    expect(acks.map((ack) => ack.status)).toEqual(['failed']);
    expect(acks[0].error).toContain(`\`!/.codebuddy/models.json\` (${m.file('.gitignore')}:1)`);
    expect(acks[0].error).toContain(`Remove \`!/.codebuddy/models.json\` from ${m.file('.gitignore')}, then apply the model config again.`);
    expect(fs.existsSync(m.file(MODELS))).toBe(false);
  }, 120_000);

  it('deletes teamai\'s .codebuddy/.gitignore when it holds only its two lines, and keeps one the member edited', async () => {
    const plain = await machine('gitignore-plain');
    const edited = await machine('gitignore-edited');
    fs.writeFileSync(plain.file('.codebuddy/.gitignore'), '# Local model credentials\nmodels.json\n');
    fs.writeFileSync(edited.file('.codebuddy/.gitignore'), '# Local model credentials\nmodels.json\nscratch/\n');

    expect((await plain.sessionStart([applyModels(plain.project)])).acks.map((ack) => ack.status)).toEqual(['success']);
    expect((await edited.sessionStart([applyModels(edited.project)])).acks.map((ack) => ack.status)).toEqual(['success']);

    expect(fs.existsSync(plain.file('.codebuddy/.gitignore'))).toBe(false);
    expect(plain.status()).toEqual([]);
    expect(fs.readFileSync(edited.file('.codebuddy/.gitignore'), 'utf8')).toBe('# Local model credentials\nmodels.json\nscratch/\n');
    expect(edited.status()).toEqual(['?? .codebuddy/.gitignore']);
  }, 120_000);

  it('removes the line once an empty model config deletes the file, and keeps it while the member\'s own key is there', async () => {
    const m = await machine('removal');
    const other = await machine('removal-member');
    await m.sessionStart([applyModels(m.project)]);
    await other.sessionStart([applyModels(other.project)]);
    const withMine = JSON.parse(fs.readFileSync(other.file(MODELS), 'utf8'));
    withMine.models.push({ id: 'mine', name: 'Mine', apiKey: 'sk-member-key' });
    fs.writeFileSync(other.file(MODELS), JSON.stringify(withMine));

    expect((await m.sessionStart([applyModels(m.project, [])])).acks.map((ack) => ack.status)).toEqual(['success']);
    expect((await other.sessionStart([applyModels(other.project, [])])).acks.map((ack) => ack.status)).toEqual(['success']);

    expect(fs.existsSync(m.file(MODELS))).toBe(false);
    expect(m.credentialLines()).toBeNull();
    // The member's key stays, and so does the line that keeps it out of git.
    expect(fs.readFileSync(other.file(MODELS), 'utf8')).toContain('sk-member-key');
    expect(fs.readFileSync(other.file(MODELS), 'utf8')).not.toContain(MODEL_KEY);
    expect(other.credentialLines()).toEqual(['/.codebuddy/models.json']);
    expect(other.status()).toEqual([]);
  }, 120_000);

  it('keeps a models file teamai did not create, and its line, when nothing of teamai\'s is left in it', async () => {
    const m = await machine('removal-not-created');
    fs.writeFileSync(m.file(MODELS), '{\n  "models": []\n}\n');
    await m.sessionStart([applyModels(m.project)]);
    expect(fs.readFileSync(m.file(MODELS), 'utf8')).toContain(MODEL_KEY);

    expect((await m.sessionStart([applyModels(m.project, [])])).acks.map((ack) => ack.status)).toEqual(['success']);
    expect(fs.readFileSync(m.file(MODELS), 'utf8')).not.toContain(MODEL_KEY);
    expect(m.credentialLines()).toEqual(['/.codebuddy/models.json']);

    const out = await m.cli(['source', 'remove-http'], m.project);

    expect(out.code, out.output).toBe(0);
    expect(fs.existsSync(m.file(MODELS))).toBe(true);
    expect(m.credentialLines()).toEqual(['/.codebuddy/models.json']);
    expect(m.status()).toEqual([]);
  }, 120_000);

  it('removing the HTTP source deletes the file, then its line', async () => {
    const m = await machine('remove-http');
    await m.sessionStart([applyModels(m.project)]);

    const out = await m.cli(['source', 'remove-http'], m.project);

    expect(out.code, out.output).toBe(0);
    expect(fs.existsSync(m.file(MODELS))).toBe(false);
    expect(m.credentialLines()).toBeNull();
    expect(m.status()).toEqual([]);
  }, 120_000);

  it('removing the HTTP source while the models file does not parse keeps the key\'s line and its record, and the retry removes both', async () => {
    const m = await machine('remove-http-retry');
    await m.sessionStart([applyModels(m.project)]);
    const delivered = fs.readFileSync(m.file(MODELS), 'utf8');
    fs.writeFileSync(m.file(MODELS), `${delivered.trimEnd()},\n`);

    const first = await m.cli(['source', 'remove-http'], m.project);

    expect(first.code, first.output).toBe(1);
    expect(first.output).toContain('removal is incomplete');
    expect(fs.readFileSync(m.file(MODELS), 'utf8')).toContain(MODEL_KEY);
    expect(m.credentialLines()).toEqual(['/.codebuddy/models.json']);
    expect(m.status()).toEqual([]);

    fs.writeFileSync(m.file(MODELS), delivered);
    const second = await m.cli(['source', 'remove-http'], m.project);

    expect(second.code, second.output).toBe(0);
    expect(fs.existsSync(m.file(MODELS))).toBe(false);
    expect(m.credentialLines()).toBeNull();
  }, 120_000);

  it('removing the HTTP source while its model record does not parse changes no models file, keeps the record, and the retry removes the key', async () => {
    const m = await machine('remove-http-record');
    await m.sessionStart([applyModels(m.project)]);
    const record = path.join(m.home, '.teamai', 'local-agent', 'model-manifest.json');
    const intact = fs.readFileSync(record, 'utf8');
    fs.writeFileSync(record, `${intact.trimEnd()},\n`);

    const first = await m.cli(['source', 'remove-http'], m.project);

    expect(first.code, first.output).toBe(1);
    expect(first.output).toContain(`Could not read teamai's model record ${record}`);
    expect(fs.readFileSync(m.file(MODELS), 'utf8')).toContain(MODEL_KEY);
    expect(m.credentialLines()).toEqual(['/.codebuddy/models.json']);

    fs.writeFileSync(record, intact);
    const second = await m.cli(['source', 'remove-http'], m.project);

    expect(second.code, second.output).toBe(0);
    expect(fs.existsSync(m.file(MODELS))).toBe(false);
    expect(m.credentialLines()).toBeNull();
  }, 120_000);

  it.skipIf(process.getuid?.() === 0)('removing the HTTP source while the exclude file is read-only reports the kept line, and the retry removes it', async () => {
    const m = await machine('remove-http-exclude');
    await m.sessionStart([applyModels(m.project)]);
    const info = path.join(m.project, '.git', 'info');
    const exclude = path.join(info, 'exclude');
    fs.chmodSync(exclude, 0o444);
    fs.chmodSync(info, 0o555);
    let first: Run;
    try {
      first = await m.cli(['source', 'remove-http'], m.project);
    } finally {
      fs.chmodSync(info, 0o755);
      fs.chmodSync(exclude, 0o644);
    }

    expect(first.code, first.output).toBe(1);
    expect(first.output).toContain('removal is incomplete');
    expect(fs.existsSync(m.file(MODELS))).toBe(false);
    expect(m.credentialLines()).toEqual(['/.codebuddy/models.json']);

    const second = await m.cli(['source', 'remove-http'], m.project);

    expect(second.code, second.output).toBe(0);
    expect(m.credentialLines()).toBeNull();
  }, 120_000);

  it('uninstall keeps the line, and warns, while the file still holds a key; drops it once the file holds none', async () => {
    const kept = await machine('uninstall-key');
    const gone = await machine('uninstall-keyless');
    await kept.sessionStart([applyModels(kept.project)]);
    await gone.sessionStart([applyModels(gone.project)]);
    fs.writeFileSync(gone.file(MODELS), '{\n  "models": [{ "id": "mine", "name": "Mine" }]\n}\n');

    const keptRun = await kept.cli(['uninstall', '--force'], kept.project);
    const goneRun = await gone.cli(['uninstall', '--force'], gone.project);

    expect(keptRun.code, keptRun.output).toBe(0);
    expect(keptRun.output).toContain(`Kept \`/.codebuddy/models.json\` in ${path.join(kept.project, '.git', 'info', 'exclude')}`);
    expect(fs.readFileSync(kept.file(MODELS), 'utf8')).toContain(MODEL_KEY);
    expect(kept.credentialLines()).toEqual(['/.codebuddy/models.json']);
    expect(kept.status()).toEqual([]);
    expect(goneRun.code, goneRun.output).toBe(0);
    expect(gone.credentialLines()).toBeNull();
    expect(gone.status()).toEqual(['?? .codebuddy/models.json']);
  }, 120_000);
});
