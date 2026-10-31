import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { check } from '../doc-check.js';
import { listServableSkills } from '../../src/skill-content.js';
import { readSkillDescription } from '../../src/agent-skills.js';
import { listFilesRecursive } from '../../src/utils/fs.js';
import { describeLiteral, INVOCATIONS, startLiteral } from '../../src/workflow/drivers/skill/literals.js';
import { TRANSITIONS, type TransitionRow } from '../../src/workflow/drivers/skill/transitions.js';

const ROOT = process.cwd();
await check('names every skill after its directory, and promises no permissions it cannot grant', async () => {
  for (const skill of await listServableSkills({
    deployRoot: path.join(ROOT, 'skills'),
    dataRoot: path.join(ROOT, 'skill-data'),
  })) {
    const text = fs.readFileSync(path.join(skill.dir, 'SKILL.md'), 'utf8');
    // A frontmatter name that disagrees with the directory makes the skill
    // undiscoverable for the agent and unresolvable for `skill get`.
    assert.match(text, new RegExp(`^name: ${skill.name}$`, 'm'));
    // `skill get` prints this frontmatter as command output; the agent never
    // processes it as skill metadata, so an `allowed-tools` line here would
    // claim grants that do not happen. Only the deployed stub's counts.
    assert.doesNotMatch(text, /^allowed-tools:/m);
  }
});

await check('keeps the deployed stub declaring its own name and tools', () => {
  const stub = fs.readFileSync(path.join(ROOT, 'skills/teamai/SKILL.md'), 'utf8');
  assert.match(stub, /^name: teamai$/m);
  // The stub is the always-loaded unit, so it pre-approves only the read-only
  // `teamai skill …` commands it asks for and the skill driver's calls that
  // cannot start a run (checked below). Everything
  // else a served workflow runs goes through the agent's own permission prompt.
  assert.match(stub, /^allowed-tools: Bash\(teamai skill:\*\), Bash\(npx teamai-cli skill:\*\), /m);
});

await check('quotes {SKILL_DIR} and $(teamai skill path …) in every command it tells the agent to run', async () => {
  // The placeholder resolves to the install path, which can hold a space
  // ("Program Files", "~/Library/Application Support", a user's full name) or
  // be a Windows path used through Bash. An unquoted occurrence in a command
  // line splits into two arguments there and the documented invocation fails.
  const offenders: string[] = [];
  for (const skill of await listServableSkills({
    deployRoot: path.join(ROOT, 'skills'),
    dataRoot: path.join(ROOT, 'skill-data'),
  })) {
    const files = [
      'SKILL.md',
      ...(await listFilesRecursive(path.join(skill.dir, 'references'))).map((f) => `references/${f}`),
    ];
    for (const relative of files) {
      if (!relative.endsWith('.md')) continue;
      const text = fs.readFileSync(path.join(skill.dir, relative), 'utf8');
      text.split('\n').forEach((line, i) => {
        // A command word followed by the bare placeholder: `python3 {SKILL_DIR}/…`.
        // Prose and reference tables name the path without running it, and a
        // quoted occurrence is already correct.
        if (/(?:^|[`\s(])(?:python3?|node|bash|sh|cp|mv|cat|ls|rm)\s+\{SKILL_DIR\}/.test(line)) {
          offenders.push(`${skill.name}/${relative}:${i + 1}: ${line.trim()}`);
        }
        // `$(teamai skill path …)` is word-split in a shell command just the
        // same, so it is always written inside double quotes.
        if (/(?<!")\$\(teamai skill path /.test(line)) {
          offenders.push(`${skill.name}/${relative}:${i + 1}: ${line.trim()}`);
        }
      });
    }
  }
  assert.deepEqual(offenders, []);
});

await check('ships no Chinese text in the deployed stub or the served content', async () => {
  // Both reach the agent as CLI output (`teamai skill get` prints skill-data/),
  // which the repo rule keeps English; the agent translates for the user.
  const offenders: string[] = [];
  for (const root of ['skills', 'skill-data']) {
    for (const relative of await listFilesRecursive(path.join(ROOT, root))) {
      const text = fs.readFileSync(path.join(ROOT, root, relative), 'utf8');
      text.split('\n').forEach((line, i) => {
        if (/[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(line))
          offenders.push(`${root}/${relative}:${i + 1}`);
      });
    }
  }
  assert.deepEqual(offenders, []);
});

await check('keeps the stub description within the 1024-character budget agents load it under', async () => {
  // With one deployed skill, this description is the only text an agent sees
  // at selection time, and hosts cap it at 1024 characters.
  const description = await readSkillDescription(path.join(ROOT, 'skills/teamai/SKILL.md'));
  assert.ok(description.length > 0);
  assert.ok(description.length <= 1024);
});
await check('pre-approves only read-only skill and workflow calls', () => {
  const stub = fs.readFileSync(path.join(ROOT, 'skills/teamai/SKILL.md'), 'utf8');
  const patterns = (stub.match(/^allowed-tools: (.*)$/m)?.[1] ?? '').split(', ');
  const calls = ['skill', 'workflow start --describe', 'workflow next', 'workflow report', 'workflow respond'];
  assert.deepEqual(
    [...patterns].sort(),
    INVOCATIONS.flatMap((invocation) => calls.map((call) => `Bash(${invocation} ${call}:*)`)).sort(),
  );
  for (const invocation of INVOCATIONS) {
    const starts = [
      startLiteral(invocation, 'ship'),
      startLiteral(invocation, 'ship', { parallel: 2, confirmed: true, inputs: true }),
    ];
    for (const pattern of patterns) {
      const prefix = pattern.replace(/^Bash\((.*):\*\)$/, '$1');
      assert.deepEqual(
        starts.filter((literal) => literal.startsWith(prefix)),
        [],
      );
    }
  }
});
await check('workflow guide starts with the describe literal', () => {
  const guide = fs.readFileSync(path.join(ROOT, 'skill-data/workflow/SKILL.md'), 'utf8');
  assert.ok(guide.includes('`' + describeLiteral('teamai', '<name>') + '`'));
});
const COLUMNS = ['id', 'state', 'input', 'guard', 'effects', 'next', 'action'] as const;

function render(row: TransitionRow): string {
  return `| ${COLUMNS.map((column) => row[column]).join(' | ')} |`.replace(/ {2}\|/g, ' |');
}

/** Every table row under `## The skill driver` in the engine notes. */
function documentedRows(): TransitionRow[] {
  const doc = fs.readFileSync(path.join(ROOT, 'docs/dev/workflow-engine.md'), 'utf8');
  const section = doc.split(/^## /m).find((part) => part.startsWith('The skill driver\n'));
  if (!section) throw new Error('docs/dev/workflow-engine.md has no "## The skill driver" section');
  return section
    .split('\n')
    .filter((line) => line.startsWith('| ') && !line.startsWith('| Row |'))
    .map((line) => {
      const cells = line
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim());
      if (cells.length !== COLUMNS.length)
        throw new Error(`A skill driver row has ${cells.length} cells, not ${COLUMNS.length}: ${line}`);
      const [id = '', state = '', input = '', guard = '', effects = '', next = '', action = ''] = cells;
      return { id, state, input, guard, effects, next, action };
    });
}

await check('documents every skill transition once, cell by cell', () => {
  const documented = documentedRows().map(render);
  const coded = TRANSITIONS.map(render);
  assert.equal(new Set(documented).size, documented.length, 'a row is documented twice');
  assert.deepEqual(
    [...documented].sort(),
    [...coded].sort(),
    `Paste these rows under ## The skill driver in docs/dev/workflow-engine.md:\n${coded.join('\n')}`,
  );
});
