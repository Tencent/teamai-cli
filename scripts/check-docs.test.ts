import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const command = path.join(ROOT, 'scripts/check-docs.mjs');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
// Each run of the check is a new process that compiles and loads about 320 TypeScript modules: about 1 s of one core
// when the machine is idle. A run without --only also executes the workflow examples in the docs: about 5.5 s idle,
// and 11 to 17 s while the full suite keeps every core busy. A case gets 30 s per run. Cases run one at a time: run
// concurrently on a CI runner busy with the full suite, they split the same cores and every full run passed 30 s.
const RUN_MS = 30_000;
vi.setConfig({ testTimeout: RUN_MS });
/** The shipped tool ids check-docs generates for teamai/tool-facts. */
const TOOL_IDS = 'oxlint-plugin-teamai/tool-ids.generated.json';
/** The lint plugin's rule registry, and the README whose table lists each of its rules. */
const LINT_RULES = 'oxlint-plugin-teamai/index.js';
const LINT_README = 'oxlint-plugin-teamai/README.md';

function checkout(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-docs-command-'));
  dirs.push(root);
  // The lint README is checked against each rule index.js registers.
  for (const name of ['docs', 'skill-data', 'skills', 'AGENTS.md', '.github', TOOL_IDS, LINT_RULES, LINT_README, ...fs.readdirSync(ROOT).filter((file) => /^README.*\.md$/.test(file))]) {
    fs.cpSync(path.join(ROOT, name), path.join(root, name), { recursive: true });
  }
  const example = 'examples/related-recall/README.md';
  fs.cpSync(path.join(ROOT, example), path.join(root, example));
  return root;
}
function run(root: string, ...args: string[]) {
  const child = spawnSync(process.execPath, [command, ...args], { cwd: root, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  expect(child.error).toBeUndefined();
  return { status: child.status, output: child.stdout + child.stderr };
}

it.each(['LF', 'CRLF'])('checks generated text and skill headings with %s Markdown', (eol) => {
  const root = checkout();
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const target = path.join(entry.parentPath, entry.name);
    const text = fs.readFileSync(target, 'utf8').replace(/\r?\n/g, eol === 'CRLF' ? '\r\n' : '\n');
    fs.writeFileSync(target, text);
  }

  const checked = run(root, '--only=skill-content');
  expect(checked.status, checked.output).toBe(0);
});

it('check refuses a stale command reference without rewriting it', () => {
  const root = checkout();
  const reference = path.join(root, 'skill-data/core/references/commands.md');
  fs.writeFileSync(reference, 'stale commands\n');
  // Generated files are compared whatever --only names, so the cheapest related check is enough.
  const checked = run(root, '--only=skill-commands-exist');
  expect(checked.status).toBe(1);
  expect(checked.output).toContain('Generated documentation is stale: skill-data/core/references/commands.md');
  expect(fs.readFileSync(reference, 'utf8')).toBe('stale commands\n');
});
it('write regenerates the command reference and a second write is stable', () => {
  const root = checkout();
  const reference = path.join(root, 'skill-data/core/references/commands.md');
  fs.writeFileSync(reference, 'stale commands\n');
  expect(run(root, '--write').status).toBe(0);
  const generated = fs.readFileSync(reference, 'utf8');
  expect(generated).toContain('# teamai command reference');
  expect(generated).toContain('teamai workflow start');
  expect(run(root, '--write').status).toBe(0);
  expect(fs.readFileSync(reference, 'utf8')).toBe(generated);
  expect(run(root).status).toBe(0);
}, 3 * RUN_MS);
it('check refuses stale support pages in both languages and write repairs them', () => {
  const root = checkout();
  const pages = ['docs/guide/tool-support.md', 'docs/guide/zh-CN/tool-support.md'];
  for (const page of pages) fs.writeFileSync(path.join(root, page), 'stale support\n');
  const checked = run(root);
  expect(checked.status).toBe(1);
  for (const page of pages) expect(checked.output).toContain(`Generated documentation is stale: ${page}`);
  for (const page of pages) expect(fs.readFileSync(path.join(root, page), 'utf8')).toBe('stale support\n');
  expect(run(root, '--write').status).toBe(0);
  for (const page of pages) expect(fs.readFileSync(path.join(root, page), 'utf8')).toContain('Claude');
  expect(run(root).status).toBe(0);
}, 3 * RUN_MS);
it('check rejects a README matrix that disagrees with the tool descriptor', () => {
  const root = checkout();
  const readme = path.join(root, 'README.md');
  fs.writeFileSync(readme, fs.readFileSync(readme, 'utf8').replace('<tr><td>Claude Code</td>', '<tr><td>Invented Tool</td>'));
  const checked = run(root, '--only=readme-matrix');
  expect(checked.status).toBe(1);
  expect(checked.output).toContain('Documentation check failed: lists every tool but the internal builds');
});
it('check rejects a lint rule with no row in the plugin README, and a row with no rule', () => {
  const root = checkout();
  const readme = path.join(root, LINT_README);
  fs.writeFileSync(readme, fs.readFileSync(readme, 'utf8').replace(/^\| `teamai\/home-env` \|.*$/mu, '| `teamai/invented-rule` | Nothing. |'));
  const checked = run(root, '--only=lint-rules-readme');
  expect(checked.status).toBe(1);
  expect(checked.output).toContain('Documentation check failed: oxlint-plugin-teamai/README.md has a row for every rule index.js registers, and none for another');
  expect(checked.output).toMatch(/no row: teamai\/home-env\b[\s\S]*no rule: teamai\/invented-rule\b/u);
});

it('check rejects an invented command in served skills', () => {
  const root = checkout();
  fs.appendFileSync(path.join(root, 'skill-data/core/SKILL.md'), '\n`teamai extract graph`\n');
  const checked = run(root, '--only=skill-commands-exist');
  expect(checked.status).toBe(1);
  expect(checked.output).toContain('unknown command "extract"');
});
it('check rejects removed wiki workflow instructions', () => {
  const root = checkout();
  fs.appendFileSync(path.join(root, 'skill-data/wiki/SKILL.md'), '\nRun GRAPH-CAPABILITIES.md first.\n');
  const checked = run(root, '--only=team-wiki-codebase-skill');
  expect(checked.status).toBe(1);
  expect(checked.output).toContain('does not point at GRAPH-CAPABILITIES.md');
});
it('check rejects a syntactically valid workflow example the engine cannot run', () => {
  const root = checkout();
  const page = path.join(root, 'docs/guide/workflow.md');
  fs.writeFileSync(page, fs.readFileSync(page, 'utf8').replace('needs: [compile]', 'needs: [missing-build-step]'));
  const checked = run(root, '--only=workflow-docs-examples');
  expect(checked.status).toBe(1);
  expect(checked.output).toContain('docs/guide/workflow.md');
  expect(checked.output).toContain('missing-build-step');
});
it('check pulls an unnamed workflow fragment on a page that is not a workflow page, and names its page and line', () => {
  const root = checkout();
  const page = path.join(root, 'docs/guide/dashboard.md');
  const before = fs.readFileSync(page, 'utf8');
  fs.writeFileSync(page, `${before}\n\`\`\`yaml\nschemaVersion: v1alpha1\ndescription: Review the change.\nsteps:\n  - id: review\n    prompt: Review the change.\n    retries_forever: true\n\`\`\`\n`);
  const checked = run(root, '--only=workflow-docs-examples');
  expect(checked.status).toBe(1);
  expect(checked.output).toContain(`docs/guide/dashboard.md:${before.split('\n').length + 2}`);
  expect(checked.output).toContain('retries_forever');
});
it.each([
  ['teamai codebase --no-such-flag', 'unknown flag "--no-such-flag"'],
  ['teamai skill gett core', 'unknown subcommand "gett"'],
])('check refuses invalid skill usage %s', (invocation, diagnostic) => {
  const root = checkout();
  fs.appendFileSync(path.join(root, 'skills/teamai/SKILL.md'), `\n\`${invocation}\`\n`);
  const checked = run(root, '--only=skill-commands-exist');
  expect(checked.status).toBe(1);
  expect(checked.output).toContain('skills/teamai/SKILL.md');
  expect(checked.output).toContain(diagnostic);
});

it('write changes only its generated files', () => {
  const root = checkout();
  const files = fs.readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((file) => fs.statSync(path.join(root, file)).isFile());
  const before = new Map(files.map((file) => [file, fs.readFileSync(path.join(root, file), 'utf8')]));
  expect(run(root, '--write').status).toBe(0);
  const generated = new Set(['skill-data/core/references/commands.md', 'docs/guide/tool-support.md', 'docs/guide/zh-CN/tool-support.md', TOOL_IDS]);
  for (const file of files.filter((name) => !generated.has(name.split(path.sep).join('/')))) {
    expect(fs.readFileSync(path.join(root, file), 'utf8'), file).toBe(before.get(file));
  }
});

it('check executes the advanced lease examples and rejects changed engine output', () => {
  const root = checkout();
  const page = path.join(root, 'docs/guide/workflow-advanced.md');
  fs.writeFileSync(page, fs.readFileSync(page, 'utf8').replace('"revision":1', '"revision":99'));
  const checked = run(root, '--only=workflow-docs-examples');
  expect(checked.status).toBe(1);
  expect(checked.output).toContain('docs/guide/workflow-advanced.md: the next table answers what the engine answers');
});

it('check refuses a deployed stub that pre-approves starting any workflow', () => {
  const root = checkout();
  const stub = path.join(root, 'skills/teamai/SKILL.md');
  fs.writeFileSync(stub, fs.readFileSync(stub, 'utf8').replace('Bash(teamai workflow start --describe:*)', 'Bash(teamai workflow start:*)'));
  const checked = run(root, '--only=skill-content');
  expect(checked.status).toBe(1);
  expect(checked.output).toContain('pre-approves only read-only skill and workflow calls');
});
it('check refuses a quoted glossary Avoid spelling in prose and ignores it in code, also an indented fence, HTML and link targets', () => {
  const root = checkout();
  fs.appendFileSync(path.join(root, 'docs/guide/workflow.md'), '\nIn folder resource form, a hook carries its script.\n');
  fs.appendFileSync(path.join(root, 'docs/guide/sharing.md'), '\n`folder resource`, <img alt="folder resource">, [x](folder-resource.md)\n\n- a step\n\n  ```sh\n  cp -r folder resources/ out/\n  ```\n');
  const checked = run(root, '--only=glossary-terms');
  expect(checked.status).toBe(1);
  expect(checked.output).toContain('docs/guide/workflow.md uses "folder resource" 1 times.');
  expect(checked.output).not.toContain('docs/guide/sharing.md');
});
