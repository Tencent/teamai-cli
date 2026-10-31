import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const command = path.join(ROOT, 'scripts/check-docs.mjs');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function checkout(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-docs-command-'));
  dirs.push(root);
  for (const name of ['docs', 'skill-data', 'skills', ...fs.readdirSync(ROOT).filter((file) => /^README.*\.md$/.test(file))]) {
    fs.cpSync(path.join(ROOT, name), path.join(root, name), { recursive: true });
  }
  return root;
}
function run(root: string, ...args: string[]) {
  const child = spawnSync(process.execPath, [command, ...args], { cwd: root, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  expect(child.error).toBeUndefined();
  return { status: child.status, output: child.stdout + child.stderr };
}

it('check refuses a stale command reference without rewriting it', () => {
  const root = checkout();
  const reference = path.join(root, 'skill-data/core/references/commands.md');
  fs.writeFileSync(reference, 'stale commands\n');
  const checked = run(root);
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
});
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
});
it('check rejects a README matrix that disagrees with the tool descriptor', () => {
  const root = checkout();
  const readme = path.join(root, 'README.md');
  fs.writeFileSync(readme, fs.readFileSync(readme, 'utf8').replace('<tr><td>Claude Code</td>', '<tr><td>Invented Tool</td>'));
  const checked = run(root);
  expect(checked.status).toBe(1);
  expect(checked.output).toContain('Documentation check failed: lists every tool but the internal builds');
});
it('check rejects an invented command in served skills', () => {
  const root = checkout();
  fs.appendFileSync(path.join(root, 'skill-data/core/SKILL.md'), '\n`teamai extract graph`\n');
  const checked = run(root);
  expect(checked.status).toBe(1);
  expect(checked.output).toContain('unknown command "extract"');
});
it('check rejects removed wiki workflow instructions', () => {
  const root = checkout();
  fs.appendFileSync(path.join(root, 'skill-data/wiki/SKILL.md'), '\nRun GRAPH-CAPABILITIES.md first.\n');
  const checked = run(root);
  expect(checked.status).toBe(1);
  expect(checked.output).toContain('does not point at GRAPH-CAPABILITIES.md');
});
it('check rejects a syntactically valid workflow example the engine cannot run', () => {
  const root = checkout();
  const page = path.join(root, 'docs/guide/workflow.md');
  fs.writeFileSync(page, fs.readFileSync(page, 'utf8').replace('needs: [compile]', 'needs: [missing-build-step]'));
  const checked = run(root);
  expect(checked.status).toBe(1);
  expect(checked.output).toContain('docs/guide/workflow.md');
  expect(checked.output).toContain('missing-build-step');
});
it.each([
  ['teamai codebase --no-such-flag', 'unknown flag "--no-such-flag"'],
  ['teamai skill gett core', 'unknown subcommand "gett"'],
])('check refuses invalid skill usage %s', (invocation, diagnostic) => {
  const root = checkout();
  fs.appendFileSync(path.join(root, 'skills/teamai/SKILL.md'), `\n\`${invocation}\`\n`);
  const checked = run(root);
  expect(checked.status).toBe(1);
  expect(checked.output).toContain('skills/teamai/SKILL.md');
  expect(checked.output).toContain(diagnostic);
});

it('write changes only its three generated files', () => {
  const root = checkout();
  const files = fs.readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((file) => fs.statSync(path.join(root, file)).isFile());
  const before = new Map(files.map((file) => [file, fs.readFileSync(path.join(root, file), 'utf8')]));
  expect(run(root, '--write').status).toBe(0);
  const generated = new Set(['skill-data/core/references/commands.md', 'docs/guide/tool-support.md', 'docs/guide/zh-CN/tool-support.md']);
  for (const file of files.filter((name) => !generated.has(name.split(path.sep).join('/')))) {
    expect(fs.readFileSync(path.join(root, file), 'utf8'), file).toBe(before.get(file));
  }
});

it('check executes the advanced lease examples and rejects changed engine output', () => {
  const root = checkout();
  const page = path.join(root, 'docs/guide/workflow-advanced.md');
  fs.writeFileSync(page, fs.readFileSync(page, 'utf8').replace('"revision":1', '"revision":99'));
  const checked = run(root);
  expect(checked.status).toBe(1);
  expect(checked.output).toContain('docs/guide/workflow-advanced.md: the next table answers what the engine answers');
});

it('check refuses a deployed stub that pre-approves starting any workflow', () => {
  const root = checkout();
  const stub = path.join(root, 'skills/teamai/SKILL.md');
  fs.writeFileSync(stub, fs.readFileSync(stub, 'utf8').replace('Bash(teamai workflow start --describe:*)', 'Bash(teamai workflow start:*)'));
  const checked = run(root);
  expect(checked.status).toBe(1);
  expect(checked.output).toContain('pre-approves only read-only skill and workflow calls');
});
