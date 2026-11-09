import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

vi.mock('../utils/logger.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../utils/logger.js')>(),
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), persist: vi.fn(), dim: vi.fn() },
}));

import { collectLayeredResources, type DefaultHookResource, type LayeredResourceList, type LayeredResourceType } from '../dashboard/layered-resources.js';
import { TeamaiConfigSchema, type LocalConfig, type TeamaiConfig } from '../types.js';

// The Resources page answers, per type, which definition of each name applies to this member, from which layer, and
// what is wrong with the others, as pull reads them (#1787).

let sandbox: string;
let repo: string;
let dataHome: string;

const teamConfig = TeamaiConfigSchema.parse({ team: 'acme', repo: 'https://example.test/acme/team.git' });

/** A member of the project `checkout`, which activates namespace `payments` of every type; `billing`'s stays inactive. */
function member(): LocalConfig {
  return { repo: { localPath: repo, remote: 'https://example.test/acme/team.git' }, username: 'tester', scope: 'user', additionalRoles: [], projects: ['checkout'], dataHome };
}

const PROJECTS = [
  'version: 1',
  'projects:',
  '  - id: checkout',
  '    resources: { workflows: [payments], hooks: [payments], mcp: [payments], benchmarks: [payments] }',
  '  - id: billing',
  '    resources: { workflows: [billing], hooks: [billing], mcp: [billing], benchmarks: [billing] }',
  '',
].join('\n');

/** A workflow named `name` with one command step. */
const workflow = (name: string): string => `schemaVersion: v1alpha1\nname: ${name}\ndescription: ${name} for the test.\nsteps:\n  - id: run\n    command: echo ${name}\n`;

async function write(files: Record<string, string>): Promise<void> {
  for (const [file, content] of Object.entries(files)) await fse.outputFile(path.join(repo, ...file.split('/')), content);
}

/** The list of `type`, with each definition as `[name, layer, form, path, state]`. */
async function listOf(type: LayeredResourceType): Promise<LayeredResourceList> {
  const list = (await collectLayeredResources(member(), teamConfig)).types.find((found) => found.type === type);

  if (!list) throw new Error(`no ${type} list`);

  return list;
}

const layerName = (layer: { kind: string; namespace?: string }): string => layer.namespace ?? layer.kind;

beforeEach(async () => {
  sandbox = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-layered-'));
  repo = path.join(sandbox, 'team');
  dataHome = path.join(sandbox, 'home', '.teamai');
  await write({ 'manifest/projects.yaml': PROJECTS });
});

afterEach(async () => {
  await fse.remove(sandbox);
});

describe('workflows on the Resources page', () => {
  it('names each definition\'s layer, form and path, what it replaces, and whether it applies', async () => {
    await write({
      'workflows/teamai-codebase-enrich/WORKFLOW.yaml': workflow('teamai-codebase-enrich'),
      'workflows/teamai-codebase-enrich/plan.sh': 'echo plan\n',
      'workflows/release.yaml': workflow('release'),
      'workflows/payments/release.yaml': workflow('release'),
      'workflows/billing/release.yaml': workflow('release'),
    });

    const { resources } = await listOf('workflows');
    const team = resources.filter((resource) => resource.layer.kind !== 'teamai');

    expect(team.map((resource) => [resource.name, layerName(resource.layer), resource.form, resource.path, resource.state.kind, resource.replaces?.path ?? null]).sort()).toEqual([
      ['release', 'billing', 'file', 'workflows/billing/release.yaml', 'inactive', null],
      ['release', 'payments', 'file', 'workflows/payments/release.yaml', 'in-force', 'workflows/release.yaml'],
      ['release', 'root', 'file', 'workflows/release.yaml', 'replaced', null],
      ['teamai-codebase-enrich', 'root', 'folder', 'workflows/teamai-codebase-enrich/', 'in-force', 'workflows/teamai-codebase-enrich.yaml'],
    ]);
  });

  it('names a duplicate and an invalid folder with what pull prints, and what runs instead', async () => {
    await write({
      'workflows/deploy.yaml': workflow('deploy'),
      'workflows/deploy/WORKFLOW.yaml': workflow('deploy'),
      'workflows/teamai-import-rules/WORKFLOW.yaml': workflow('teamai-import-rules'),
    });
    await fse.symlink('/etc/hosts', path.join(repo, 'workflows', 'teamai-import-rules', 'link.sh'));

    const { resources } = await listOf('workflows');
    const states = resources.filter((resource) => resource.name === 'deploy' || resource.name === 'teamai-import-rules').map((resource) => [resource.path, resource.state]);

    expect(states).toEqual([
      ['workflows/deploy.yaml', {
        kind: 'conflict',
        reason: 'duplicate',
        message: 'workflows/deploy.yaml:1: field "(root)": Workflow "deploy" is defined twice in one place, as workflows/deploy.yaml and as workflows/deploy/; a workflow defined twice has no runnable version',
      }],
      ['workflows/deploy/', {
        kind: 'conflict',
        reason: 'duplicate',
        message: 'workflows/deploy.yaml:1: field "(root)": Workflow "deploy" is defined twice in one place, as workflows/deploy.yaml and as workflows/deploy/; a workflow defined twice has no runnable version',
      }],
      ['workflows/teamai-import-rules/', {
        kind: 'invalid',
        message: 'workflows/teamai-import-rules/WORKFLOW.yaml:1: field "(root)": workflows/teamai-import-rules/ is not a valid workflow folder: link.sh is a symlink',
        fallback: 'default',
      }],
    ]);
  });

  it('lists a folder\'s files with their size and executable bit, against the 1 MB limit, and where a run keeps them', async () => {
    await write({ 'workflows/release/WORKFLOW.yaml': workflow('release'), 'workflows/release/plan.sh': 'echo plan\n', 'workflows/release/notes/summary.md': 'Summarise.\n' });
    await fse.chmod(path.join(repo, 'workflows', 'release', 'plan.sh'), 0o755);

    const release = (await listOf('workflows')).resources.find((resource) => resource.name === 'release');
    const pinned = release?.folder?.delivered;

    expect([release?.folder?.files, release?.folder?.bytes, release?.folder?.limit, pinned?.by, pinned?.present, path.dirname(pinned?.path ?? '')]).toEqual([
      [
        { path: 'WORKFLOW.yaml', bytes: Buffer.byteLength(workflow('release')), executable: false },
        { path: 'notes/summary.md', bytes: 11, executable: false },
        { path: 'plan.sh', bytes: 10, executable: true },
      ],
      Buffer.byteLength(workflow('release')) + 21,
      1024 * 1024,
      'run',
      false,
      path.join(dataHome, 'workflows', 'folders'),
    ]);
  });
});

const BLOCK_SECRETS = 'description: Scan for secrets before a commit\nevent: PreToolUse\nmatcher: Bash\ncommand: bash "${TEAMAI_HOOK_DIR}/scan.sh"\n';

/** `hooks.yaml` declaring the hook `id`. */
const hooksYaml = (id: string): string => `hooks:\n  - id: ${id}\n    description: ${id}\n    event: Stop\n    command: npm run ${id}\n`;

/** `dir` with forward slashes, as a rendered command names it. */
const rendered = (dir: string): string => dir.split(path.sep).join('/');

describe('hooks on the Resources page', () => {
  it('lists folders and hooks.yaml entries by layer, and the folder\'s command with its delivered path filled in', async () => {
    await write({
      'hooks/block-secrets/HOOK.yaml': BLOCK_SECRETS,
      'hooks/block-secrets/scan.sh': 'exit 0\n',
      'hooks/hooks.yaml': hooksYaml('lint'),
      'hooks/payments/hooks.yaml': hooksYaml('lint'),
      'hooks/billing/hooks.yaml': hooksYaml('audit'),
    });

    const { resources } = await listOf('hooks');
    const blockSecrets = resources.find((resource) => resource.name === 'block-secrets');

    expect(resources.map((resource) => [resource.name, layerName(resource.layer), resource.form, resource.path, resource.state.kind, resource.replaces?.path ?? null]).sort()).toEqual([
      ['audit', 'billing', 'entry', 'hooks/billing/hooks.yaml', 'inactive', null],
      ['block-secrets', 'root', 'folder', 'hooks/block-secrets/', 'in-force', null],
      ['lint', 'payments', 'entry', 'hooks/payments/hooks.yaml', 'in-force', 'hooks/hooks.yaml'],
      ['lint', 'root', 'entry', 'hooks/hooks.yaml', 'replaced', null],
    ]);
    expect([blockSecrets?.folder?.runs, blockSecrets?.folder?.delivered]).toEqual([
      { command: `bash "${rendered(path.join(dataHome, 'hooks', 'block-secrets'))}/scan.sh"`, args: [], env: [] },
      { path: path.join(dataHome, 'hooks', 'block-secrets'), present: false, by: 'pull' },
    ]);
  });
});

describe('MCP servers on the Resources page', () => {
  it('refuses an http folder with what pull prints, and holds every other server of the run, as pull does', async () => {
    await write({
      'mcp/jira-lite/MCP.yaml': 'description: Jira lookups\ntransport: http\nurl: https://jira.example.test/mcp\n',
      'mcp/jira-lite/server.py': 'print("hi")\n',
      'mcp/mcp.yaml': 'servers:\n  - name: github\n    transport: stdio\n    command: npx\n    args: ["-y", "@modelcontextprotocol/server-github@1.0.0"]\n    env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" }\n',
    });

    const { resources } = await listOf('mcp');
    const stopped = 'mcp/jira-lite/MCP.yaml: transport http is refused in a folder, which holds the files of a server teamai starts (stdio). '
      + 'A URL server carries no files: declare it in mcp.yaml. mcp was not applied this run, so your installed team MCP servers are unchanged. '
      + 'Fix the file in the team repo and push.';

    expect(resources.map((resource) => [resource.name, resource.form, resource.state]).sort()).toEqual([
      ['github', 'entry', { kind: 'blocked', message: stopped }],
      ['jira-lite', 'folder', { kind: 'invalid', message: stopped, fallback: 'installed' }],
    ]);
  });

  it('leaves a broken folder in a namespace this member does not activate inactive, as pull never reads it', async () => {
    await write({
      'mcp/billing/jira-lite/MCP.yaml': 'transport: http\nurl: https://jira.example.test/mcp\n',
      'mcp/mcp.yaml': 'servers:\n  - name: github\n    transport: stdio\n    command: npx\n',
    });

    const { resources, problems } = await listOf('mcp');

    expect([resources.map((resource) => [resource.name, resource.state.kind]).sort(), problems]).toEqual([[['github', 'in-force'], ['jira-lite', 'inactive']], []]);
  });

  it('shows a server folder\'s command and args with its delivered path filled in, and its env by name only', async () => {
    await write({
      'mcp/jira-lite/MCP.yaml': 'transport: stdio\ncommand: uv\nargs: ["run", "--script", "${TEAMAI_MCP_DIR}/server.py"]\nenv: { JIRA_TOKEN: "${JIRA_TOKEN}", JIRA_URL: "https://jira.example.test" }\n',
      'mcp/jira-lite/server.py': 'print("hi")\n',
    });

    const [jira] = (await listOf('mcp')).resources;

    expect([jira?.state.kind, jira?.folder?.runs]).toEqual(['in-force', {
      command: 'uv',
      args: ['run', '--script', `${rendered(path.join(dataHome, 'mcp', 'jira-lite'))}/server.py`],
      env: ['JIRA_TOKEN', 'JIRA_URL'],
    }]);
    expect(JSON.stringify(await collectLayeredResources(member(), teamConfig))).not.toContain('jira.example.test');
  });
});

/** teamai's own folder of default hook `name`, which a team copies to replace it. */
const shippedFolder = (name: string): string => path.join(import.meta.dirname, '..', '..', 'hooks', name);

/** The default hook `name` as the page shows it. */
async function defaultHook(name: string, config: TeamaiConfig = teamConfig): Promise<DefaultHookResource> {
  const found = (await collectLayeredResources(member(), config)).defaultHooks.find((hook) => hook.name === name);

  if (!found) throw new Error(`no default hook ${name}`);

  return found;
}

describe('default hooks on the Resources page', () => {
  it('compares each with: parameter with teamai\'s, and names the texts the team\'s folder changes', async () => {
    const folder = path.join(repo, 'hooks', 'teamai-friction-reminder');
    await fse.copy(shippedFolder('teamai-friction-reminder'), folder);
    await write({
      'hooks/teamai-friction-reminder/HOOK.yaml': 'description: Ours\nwith:\n  min_tools: 30\n  weights: { reject: 30 }\n',
      'hooks/teamai-friction-reminder/task.md': 'Our task: {{ task }}\n',
    });

    const reminder = await defaultHook('teamai-friction-reminder');
    const param = (key: string) => reminder.params.find((found) => found.key === key);
    const text = (name: string) => reminder.texts.find((found) => found.text === name);

    expect([reminder.state, param('min_tools'), param('weights.reject'), param('weights.interrupt'), text('task'), text('problem')]).toEqual([
      { kind: 'replaced', path: 'hooks/teamai-friction-reminder/' },
      { key: 'min_tools', teamai: 15, team: 30 },
      { key: 'weights.reject', teamai: 20, team: 30 },
      { key: 'weights.interrupt', teamai: 20, team: null },
      { text: 'task', file: 'task.md', replaced: true },
      { text: 'problem', file: 'problem.md', replaced: false },
    ]);
  });

  it('names why pull refuses a replacement, with the value it refuses, and lists it once', async () => {
    await fse.copy(shippedFolder('teamai-friction-reminder'), path.join(repo, 'hooks', 'teamai-friction-reminder'));
    await write({ 'hooks/teamai-friction-reminder/HOOK.yaml': 'description: Ours\nwith:\n  min_tools: 5000\n' });

    const reminder = await defaultHook('teamai-friction-reminder');
    const hooks = await listOf('hooks');

    expect([reminder.state, reminder.params.find((found) => found.key === 'min_tools'), reminder.delivered, hooks.resources, hooks.problems]).toEqual([
      {
        kind: 'refused',
        path: 'hooks/teamai-friction-reminder/',
        messages: ['hooks/teamai-friction-reminder/ is refused, and teamai\'s default stays in force until it is fixed: HOOK.yaml: with.min_tools must be a whole number from 1 to 1000'],
      },
      { key: 'min_tools', teamai: 15, team: 5000 },
      null,
      [],
      [],
    ]);
  });

  it('names the variant of each text the hint reads for the team\'s language, from the folder in force', async () => {
    await fse.copy(shippedFolder('teamai-friction-reminder'), path.join(repo, 'hooks', 'teamai-friction-reminder'));
    await fse.remove(path.join(repo, 'hooks', 'teamai-friction-reminder', 'task.zh.md'));
    const chinese = TeamaiConfigSchema.parse({ ...teamConfig, language: 'zh' });

    const reminder = await defaultHook('teamai-friction-reminder', chinese);
    const envHint = await defaultHook('teamai-env-hint', chinese);

    expect([reminder.texts.find(({ text }) => text === 'task'), reminder.texts.find(({ text }) => text === 'gap'), envHint.state, envHint.params]).toEqual([
      { text: 'task', file: 'task.md', replaced: true },
      { text: 'gap', file: 'gap.zh.md', replaced: false },
      { kind: 'teamai' },
      [],
    ]);
  });
});

/** Suite `name`'s `SUITE.yaml`, run `repetitions` times, and its one task. */
const suite = (name: string, repetitions = 1): Record<string, string> => ({
  SUITE: `schemaVersion: v1alpha1\nname: ${name}\nrepo: https://github.com/fixture/app.git\ndefaults:\n  tool: claude\narms:\n  - name: now\nrepetitions: ${repetitions}\ntimeout: 10m\n`,
  task: 'schemaVersion: v1alpha1\ntitle: Fix it\nprompt: Fix.\nstartingCommit: 0123456789abcdef0123456789abcdef01234567\ncheck: { run: node test.js, protect: [test.js] }\n',
});

/** Suite `name` in `dir`, `benchmarks/[<ns>/]<name>`. */
const suiteAt = (dir: string, name: string, repetitions = 1): Record<string, string> => {
  const { SUITE, task } = suite(name, repetitions);

  return { [`${dir}/SUITE.yaml`]: SUITE, [`${dir}/tasks/fix.yaml`]: task };
};

describe('benchmark suites on the Resources page', () => {
  it('names each suite folder\'s layer, what it replaces, whether it applies, and what pull prints about an invalid one', async () => {
    await write({
      ...suiteAt('benchmarks/smoke', 'smoke'),
      ...suiteAt('benchmarks/payments/smoke', 'smoke'),
      ...suiteAt('benchmarks/billing/smoke', 'smoke'),
      ...suiteAt('benchmarks/broken', 'broken', 0),
    });

    const { resources, marker } = await listOf('benchmarks');
    const broken = resources.find((resource) => resource.name === 'broken');

    expect([marker, resources.map((resource) => [resource.name, layerName(resource.layer), resource.form, resource.path, resource.state.kind, resource.replaces?.path ?? null]).sort()]).toEqual([
      'SUITE.yaml',
      [
        ['broken', 'root', 'folder', 'benchmarks/broken/', 'invalid', null],
        ['smoke', 'billing', 'folder', 'benchmarks/billing/smoke/', 'inactive', null],
        ['smoke', 'payments', 'folder', 'benchmarks/payments/smoke/', 'in-force', 'benchmarks/smoke/'],
        ['smoke', 'root', 'folder', 'benchmarks/smoke/', 'replaced', null],
      ],
    ]);
    expect(broken?.state).toEqual({ kind: 'invalid', message: expect.stringMatching(/^benchmarks\/broken\/SUITE\.yaml:\d+: field "repetitions": /), fallback: 'none' });
  });
});
