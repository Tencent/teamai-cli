import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'dist', 'index.js');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'TeamAI CI',
  GIT_AUTHOR_EMAIL: 'ci@teamai.test',
  GIT_COMMITTER_NAME: 'TeamAI CI',
  GIT_COMMITTER_EMAIL: 'ci@teamai.test',
  GIT_TERMINAL_PROMPT: '0',
};

type Ran = { code: number | null; stdout: string; stderr: string };

const sandboxes: string[] = [];

afterEach(() => {
  for (const root of sandboxes.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, ...GIT_ENV } });
}

const fwd = (value: string): string => value.split(path.sep).join('/');

/**
 * A `claude` that logs `start <label> <ms> lock=<bool>` and `end <label> <ms>` for each prompt: the component it names,
 * `architecture` or `g5`, and whether an import lock is in `locks`. It fails the labels in FAKE_FAIL, and with
 * FAKE_WAIT=n waits, up to 5 s, until n prompts started.
 */
function fakeClaude(bin: string, log: string, locks: string): void {
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
const fs = require('fs');
const log = ${JSON.stringify(log)};
let stdin = ''; process.stdin.on('data', (d) => stdin += d); process.stdin.on('end', async () => {
  const named = /模块: (\\S+)/.exec(stdin);
  const label = named ? named[1] : stdin.includes('技术架构总览') ? 'architecture' : stdin.includes('sequenceDiagram') ? 'g5' : 'other';
  fs.appendFileSync(log, 'start ' + label + ' ' + Date.now() + ' lock=' + (fs.existsSync(${JSON.stringify(locks)}) && fs.readdirSync(${JSON.stringify(locks)}).length > 0) + '\\n');
  const wait = Number(process.env.FAKE_WAIT || 0);
  const until = Date.now() + 5000;
  while (wait > 0 && Date.now() < until && fs.readFileSync(log, 'utf8').split('\\n').filter((l) => l.startsWith('start ')).length < wait) await new Promise((r) => setTimeout(r, 20));
  fs.appendFileSync(log, 'end ' + label + ' ' + Date.now() + '\\n');
  if ((process.env.FAKE_FAIL || '').split(',').includes(label)) { process.stderr.write('Authentication failed\\n'); process.exit(2); }
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: '# ' + label + ' doc\\n', usage: { input_tokens: 10, output_tokens: 5 } }));
});\n`, { mode: 0o755 });
}

interface Sandbox {
  home: string;
  project: string;
  remote: string;
  wikiRoot: string;
  docs: string;
  log: string;
  run: (args: string[], extra?: Record<string, string>) => Promise<Ran>;
  /** Starts the CLI as `run` does, and gives the process with what it ended with. */
  start: (args: string[], extra?: Record<string, string>) => { child: ChildProcess; ran: Promise<Ran> };
  calls: () => string[];
}

/** A team repo on the git provider whose teamwiki holds the extracted evidence of `widget`: components api, cli, web. */
function sandbox(): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-deep-enrich-workflow-'));
  sandboxes.push(root);
  const home = path.join(root, 'home');
  const remote = path.join(root, 'team.git');
  const work = path.join(root, 'work');
  const localPath = path.join(home, '.teamai', 'team-repo');
  const project = path.join(root, 'project');
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'claude.log');
  fakeClaude(bin, log, path.join(home, '.teamai', 'locks'));

  git(['init', '-q', '--bare', '-b', 'main', remote], root);
  git(['init', '-q', '-b', 'main', work], root);
  fs.writeFileSync(path.join(work, 'teamai.yaml'), ['team: wiki', 'description: wiki fixture', `repo: ${fwd(remote)}`, 'provider: git', 'usageReport: false', ''].join('\n'));
  const evidence = path.join(work, 'teamwiki', 'evidence', 'code', 'widget');
  fs.mkdirSync(path.join(evidence, 'modules'), { recursive: true });
  fs.writeFileSync(path.join(evidence, '_manifest.json'), JSON.stringify({
    schemaVersion: 'team-wiki.codebase-output-manifest.v2',
    project: 'widget',
    generatedAt: '2026-01-01T00:00:00.000Z',
    components: [{ slug: 'api', responsibilities: ['serve HTTP'] }, { slug: 'cli', responsibilities: ['parse args'] }, { slug: 'web', responsibilities: ['render pages'] }],
    edges: [{ from: 'cli', to: 'api', relation: 'DEPENDS_ON', confidence: 'EXTRACTED' }, { from: 'web', to: 'api', relation: 'DEPENDS_ON', confidence: 'EXTRACTED' }],
  }));
  for (const module of ['api', 'cli', 'web']) fs.writeFileSync(path.join(evidence, 'modules', `${module}.md`), `# ${module}\n\nModule ${module} facts.\n`);
  fs.writeFileSync(path.join(evidence, 'dependency-paths.md'), '# Dependency Paths\n\n## cli main\n- cli -> api\n');
  fs.writeFileSync(path.join(work, 'teamwiki', 'router.md'), '# Router\n');
  fs.writeFileSync(path.join(work, 'teamwiki', 'index.md'), '# Index\n\n## Navigation\n');
  git(['add', '-A'], work);
  git(['commit', '-qm', 'wiki'], work);
  git(['remote', 'add', 'origin', remote], work);
  git(['push', '-q', 'origin', 'main'], work);
  git(['clone', '-q', remote, localPath], root);
  fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), [
    'repo:', `  localPath: ${fwd(localPath)}`, `  remote: ${fwd(remote)}`, '  kind: git',
    'username: alice', 'updatePolicy: auto', 'additionalRoles: []', 'scope: user', '',
  ].join('\n'));
  git(['init', '-q', '-b', 'main', project], root);
  fs.writeFileSync(path.join(project, 'README.md'), 'hi\n');
  git(['add', '-A'], project);
  git(['commit', '-qm', 'init'], project);

  const wikiRoot = path.join(localPath, 'teamwiki');

  const start = (args: string[], extra?: Record<string, string>): { child: ChildProcess; ran: Promise<Ran> } => {
    const child = spawn('node', [CLI, ...args], {
      env: { ...process.env, ...GIT_ENV, FORCE_COLOR: '0', HOME: home, USERPROFILE: home, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, TEAMAI_AI_TOOL: '', ...extra },
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: project,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.stdin.end();

    return { child, ran: new Promise((resolve) => { child.on('close', (code) => resolve({ code, stdout, stderr })); }) };
  };

  return {
    home,
    project,
    remote,
    wikiRoot,
    docs: path.join(wikiRoot, 'evidence', 'code', 'widget', 'docs'),
    log,
    run: (args, extra) => start(args, extra).ran,
    start,
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []),
  };
}

const lastCommit = (remote: string): string => execFileSync('git', ['log', '-1', '--format=%s', 'main'], { cwd: remote, encoding: 'utf8' }).trim();

const GRAPH_DOCS = ['README.md', 'graph-coverage.md', 'graph-g1-relations.md', 'graph-g2-dataflow.md', 'graph-g3-interfaces.md', 'graph-g4-errors.md', 'graph-g6-triples.md', 'graph-g7-risks.md', 'graph-g8-config.md', 'graph-g9-constraints.md'];

describe('codebase --deep-enrich through teamai-codebase-deep-enrich', () => {
  beforeAll(() => {
    if (!fs.existsSync(CLI)) throw new Error(`CLI binary not found at ${CLI}. Run "npm run build" first.`);
  });

  it('writes every doc, prints the lines it printed before, and publishes them', async () => {
    const box = sandbox();

    const ran = await box.run(['codebase', '--deep-enrich', '--project', 'widget']);

    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stdout.split('\n')).toEqual([
      `ℹ deep-enrich[widget]: Starting deep knowledge generation, evidenceDir=${path.join(box.wikiRoot, 'evidence', 'code', 'widget')}`,
      'ℹ deep-enrich[widget]: Phase 1 — Generating 3 component design docs',
      'ℹ deep-enrich[widget]: Phase 2 — Generating architecture overview',
      'ℹ deep-enrich[widget]: Phase 3 — Generating deterministic graph docs',
      'ℹ deep-enrich[widget]: Phase 4 — Generating AI graph docs (G5/G6)',
      'ℹ deep-enrich[widget]: Phase 5 — Index enhancement',
      '✔ deep-enrich[widget]: Deep knowledge generation complete',
      `✔ Pushed to team knowledge repo (${fwd(box.remote)})`,
      'Deep enrichment complete: project=widget',
      '',
    ]);
    expect(fs.readdirSync(box.docs).toSorted()).toEqual([...GRAPH_DOCS, 'api.md', 'architecture.md', 'cli.md', 'graph-g5-scenarios.md', 'web.md'].toSorted());
    expect(fs.readFileSync(path.join(box.docs, 'cli.md'), 'utf8')).toBe('# cli doc');
    expect(lastCommit(box.remote)).toBe('[teamai] Deep enrich: widget');
  });

  it('keeps another import out of a run that stopped, then publishes its docs once workflow resume finishes it, leaving the team checkout clean', async () => {
    const box = sandbox();
    const first = box.start(['codebase', '--deep-enrich', '--project', 'widget'], { FAKE_WAIT: '99' });
    await expect.poll(() => box.calls().some((line) => line.startsWith('start ')), { timeout: 60_000 }).toBe(true);
    first.child.kill('SIGKILL');
    await first.ran;
    const listed = await box.run(['workflow', 'resume']);
    const run = /teamai workflow resume (r[0-9a-f]{16})/.exec(listed.stdout + listed.stderr)?.[1];
    expect(run, listed.stdout + listed.stderr).toBeDefined();
    const other = await box.run(['codebase', '--deep-enrich', '--project', 'widget']);
    expect(other.code).not.toBe(0);
    expect(other.stdout + other.stderr).toContain(
      `, in workflow run ${run ?? ''}. Finish it with teamai workflow resume ${run ?? ''}, or cancel it with teamai workflow cancel ${run ?? ''}, then run this command again.`,
    );

    const resumed = await box.run(['workflow', 'resume', run ?? '']);

    expect(resumed.code, resumed.stdout + resumed.stderr).toBe(0);
    expect(fs.readdirSync(box.docs)).toContain('architecture.md');
    expect(lastCommit(box.remote)).toBe('[teamai] Deep enrich: widget');
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: path.dirname(box.wikiRoot), encoding: 'utf8' })).toBe('');
    const again = await box.run(['codebase', '--deep-enrich', '--project', 'widget']);
    expect(again.code, again.stdout + again.stderr).toBe(0);
  });

  it('names a component the tool could not write, writes the others, and exits 1', async () => {
    const box = sandbox();

    const ran = await box.run(['codebase', '--deep-enrich', '--project', 'widget'], { FAKE_FAIL: 'cli' });

    expect(ran.code, ran.stderr).toBe(1);
    expect(ran.stdout).toContain('⚠ deep-enrich[widget]: Skipping component cli: AI call failed (tool: claude): Authentication failed\n');
    expect(ran.stdout).toContain('Deep enrichment incomplete: project=widget, missing component docs: cli\n');
    expect(ran.stdout).not.toContain('falling back to sequential');
    expect(box.calls().filter((line) => line.startsWith('start cli'))).toHaveLength(1);
    expect(fs.existsSync(path.join(box.docs, 'cli.md'))).toBe(false);
    expect(fs.existsSync(path.join(box.docs, 'api.md'))).toBe(true);
    expect(lastCommit(box.remote)).toBe('[teamai] Deep enrich: widget');
  });

  it('fails on an ai.tool that cannot run, writing and publishing nothing', async () => {
    const box = sandbox();

    const ran = await box.run(['codebase', '--deep-enrich', '--project', 'widget'], { TEAMAI_AI_TOOL: 'gemini' });

    expect(ran.code, ran.stdout).toBe(1);
    const failures = ran.stderr.split('\n').filter((line) => line.includes('failed with tool_unconfigured'));
    expect(failures).toEqual([
      expect.stringMatching(/^✖ 3 steps failed with tool_unconfigured \(components\[0\]\.ask, components\[1\]\.ask, components\[2\]\.ask\): TEAMAI_AI_TOOL is "gemini", which is not a tool teamai launches\./),
    ]);
    expect(fs.existsSync(box.docs)).toBe(false);
    expect(box.calls()).toEqual([]);
    expect(lastCommit(box.remote)).toBe('wiki');
  });

  it('prints the run envelope with --json', async () => {
    const box = sandbox();

    const ran = await box.run(['codebase', '--deep-enrich', '--project', 'widget', '--json'], { FAKE_FAIL: 'architecture' });

    expect(ran.code, ran.stderr).toBe(1);
    expect(JSON.parse(ran.stdout).data.done.outputs).toEqual({
      text: 'Deep enrichment incomplete: project=widget, missing architecture.md',
      exit_code: 1,
      complete: false,
      missing_components: [],
      missing_architecture: true,
    });
  });

  it('asks for every component at once by default', async () => {
    const box = sandbox();

    const ran = await box.run(['codebase', '--deep-enrich', '--project', 'widget'], { FAKE_WAIT: '3' });

    expect(ran.code, ran.stderr).toBe(0);
    expect(box.calls().slice(0, 3).map((line) => line.split(' ')[0])).toEqual(['start', 'start', 'start']);
  });

  it('asks for as many components at once as the concurrency input says', async () => {
    const box = sandbox();
    const inputs = { wiki_root: box.wikiRoot, project: 'widget', max_modules: 0, concurrency: 2 };

    const ran = await box.run(['workflow', 'start', 'teamai-codebase-deep-enrich', '--driver', 'local', '--inputs', JSON.stringify(inputs)], { FAKE_WAIT: '3' });

    expect(ran.code, ran.stderr).toBe(0);
    // The fake waits for a third start that cannot come while two are open, so both end before the third starts.
    expect(box.calls().slice(0, 5).map((line) => line.split(' ')[0])).toEqual(['start', 'start', 'end', 'end', 'start']);
  });

  it('writes an --output teamwiki in the checkout with no teamai init, leaving nothing in the member\'s home', async () => {
    const box = sandbox();
    fs.cpSync(box.wikiRoot, path.join(box.project, 'wiki', 'teamwiki'), { recursive: true });
    fs.rmSync(path.join(box.home, '.teamai'), { recursive: true, force: true });
    const docs = path.join(box.project, 'wiki', 'teamwiki', 'evidence', 'code', 'widget', 'docs');

    const ran = await box.run(['codebase', '--deep-enrich', '--project', 'widget', '--output', './wiki'], { FAKE_FAIL: 'cli' });

    expect(ran.code, ran.stderr).toBe(1);
    expect(ran.stdout).toContain('Deep enrichment incomplete: project=widget, missing component docs: cli\n');
    expect(ran.stderr.split('\n')).toEqual(['✖ Step "components[1].ask" failed with tool_failed: AI call failed (tool: claude): Authentication failed', '']);
    expect(box.calls().filter((line) => line.startsWith('start cli'))).toHaveLength(1);
    expect(fs.readdirSync(docs)).toContain('api.md');
    expect(fs.readdirSync(docs)).not.toContain('cli.md');
    // A run with no init keeps its config and run files out of the member's data home, which holds the log as before,
    // and the directory of the machine's import locks, with no lock left in it.
    const teamai = path.join(box.home, '.teamai');
    expect((fs.existsSync(teamai) ? fs.readdirSync(teamai) : []).filter((name) => name !== 'debug.log' && name !== 'locks')).toEqual([]);
    expect(fs.readdirSync(path.join(teamai, 'locks'))).toEqual([]);
  });

  it('writes an --output teamwiki in the checkout of a member with teamai init, publishing nothing', async () => {
    const box = sandbox();
    fs.cpSync(box.wikiRoot, path.join(box.project, 'wiki', 'teamwiki'), { recursive: true });
    const docs = path.join(box.project, 'wiki', 'teamwiki', 'evidence', 'code', 'widget', 'docs');

    const ran = await box.run(['codebase', '--deep-enrich', '--project', 'widget', '--output', './wiki']);

    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stdout).toContain('Deep enrichment complete: project=widget\n');
    expect(fs.readdirSync(docs)).toContain('cli.md');
    expect(fs.existsSync(box.docs)).toBe(false);
    expect(lastCommit(box.remote)).toBe('wiki');
  });

  it('lets another import into an --output teamwiki with no teamai init once a run there stopped, as no resume can finish it', async () => {
    const box = sandbox();
    fs.cpSync(box.wikiRoot, path.join(box.project, 'wiki', 'teamwiki'), { recursive: true });
    fs.rmSync(path.join(box.home, '.teamai'), { recursive: true, force: true });
    const first = box.start(['codebase', '--deep-enrich', '--project', 'widget', '--output', './wiki'], { FAKE_WAIT: '99' });
    await expect.poll(() => box.calls().some((line) => line.startsWith('start ')), { timeout: 60_000 }).toBe(true);
    first.child.kill('SIGKILL');
    await first.ran;

    const other = await box.run(['codebase', '--deep-enrich', '--project', 'widget', '--output', './wiki']);

    expect(other.code, other.stdout + other.stderr).toBe(0);
    expect(other.stdout).toContain('Deep enrichment complete: project=widget');
  });

  it('holds the import lock of the team repo while the hidden deep-enrich writes its teamwiki', async () => {
    const box = sandbox();

    const ran = await box.run(['deep-enrich', '--project', 'widget', '--wiki-root', box.wikiRoot]);

    expect(ran.code, ran.stderr).toBe(0);
    const starts = box.calls().filter((line) => line.startsWith('start '));
    expect(starts).toHaveLength(5);
    expect(starts.every((line) => line.endsWith(' lock=true'))).toBe(true);
    expect(fs.readdirSync(path.join(box.home, '.teamai', 'locks'))).toEqual([]);
    expect(lastCommit(box.remote)).toBe('wiki');
  });
});
