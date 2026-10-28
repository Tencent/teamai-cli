import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureAstReady, getLanguage, getParser } from '../wiki-engine/code-knowledge/ast/parser-registry.js';

/** One import of a module: `to` is a path under `src/`, or a package name as written. */
interface Edge {
  from: string;
  to: string;
  typeOnly: boolean;
  /** The names a static import or re-export binds, empty for a namespace, side-effect or dynamic import. */
  names: string[];
}

const ROOT = path.join(import.meta.dirname, '../..');
const SKILL = 'src/workflow/drivers/skill/';
const LOCAL = 'src/workflow/drivers/local/';
const PLACE = 'src/workflow/place/';
const DISCOVERY = 'src/workflow/discovery/';
const FLAT = 'src/workflow/';

/** Rule 1: what a module under `drivers/skill/` may import, besides its siblings, `zod` and `node:*`. */
const SKILL_IMPORTS: Record<string, { typeOnly?: true; names?: string[] }> = {
  'src/workflow/protocol.ts': {},
  'src/workflow/types.ts': { typeOnly: true },
  'src/workflow/requirements.ts': { typeOnly: true },
  'src/workflow/describe.ts': { typeOnly: true },
  'src/workflow/attempt-marker.ts': {},
  // The wire shapes the engine answers with, which every driver parses with the same schema.
  'src/workflow/lease-wire.ts': { names: ['LeaseWireSchema'] },
  'src/workflow/step-state.ts': { names: ['FailureSchema'] },
  'src/workflow/store.ts': { names: ['takeRunLock', 'LockTaken', 'RunLock', 'attemptDir', 'attemptResultPath', 'skillStatePath', 'RunIdSchema', 'RunId', 'AttemptIdSchema', 'AttemptId', 'withRunnerLock', 'runnerAlive'] },
  'src/workflow/step-model.ts': {},
  'src/env-resolution.ts': {},
  'src/env-exec.ts': { names: ['stepEnvironment'] },
  'src/utils/redact.ts': {},
  'src/utils/session-id.ts': {},
  // Equal values as equal text, so a kept end is compared with the engine's latest one.
  'src/utils/canonical-json.ts': {},
  'src/resources/agent-format.ts': {},
  'src/tool-launch/process-stop.ts': {},
  // Whether the local driver launches the session's tool, so a local start or resume can name it.
  'src/tool-launch/tools.ts': { names: ['isLaunchTool', 'LAUNCH_ORDER', 'LaunchTool'] },
  'src/builtin-hooks.ts': { names: ['resolveCliEntry'] },
  // The tools a session may name with `--tools default=<tool>`, which of them a child's model resolves for, and the
  // skill-data root the host question's reference is under.
  'src/tools.ts': { names: ['isToolId', 'TOOLS', 'isAgentToolId'] },
  'src/skill-content.ts': { names: ['packagedSkillRoots'] },
  // What the confined judge of the session tool can do, which the driver declares on `score --next`.
  'src/scorers/judge.ts': { names: ['isJudgeTool', 'judgeAccess'] },
  'src/scorers/label.ts': { typeOnly: true },
  // The identity every driver reports, the repository's atomic file writes, and the shared config types.
  'src/driver-identity.ts': {},
  // The run mode: whether a person attends the run, which describe answers for and every attempt's process gets.
  'src/launch-context.ts': { names: ['resolveRunMode', 'RunMode', 'RUN_MODES', 'RunModeSchema'] },
  'src/utils/fs.ts': {},
  'src/types.ts': { typeOnly: true },
};

/** Rule 3: the modules through which code outside a folder reaches it; tests may also import the entries of their unit. */
const ENTRIES: Array<{ folder: string; entries: Record<string, string[] | 'any'>; testEntries: string[] }> = [
  { folder: SKILL, entries: { 'skill-driver.ts': 'any', 'literals.ts': ['src/workflow/discovery/render.ts'] }, testEntries: ['skill-driver.ts', 'literals.ts'] },
  { folder: PLACE, entries: { 'place.ts': ['src/workflow/protocol.ts', 'src/workflow/drivers/local/local-driver.ts'] }, testEntries: ['place.ts'] },
  { folder: LOCAL, entries: { 'local-driver.ts': ['src/workflow-commands.ts'], 'local-tool-adapter.ts': [] }, testEntries: ['local-driver.ts', 'local-tool-adapter.ts'] },
  { folder: DISCOVERY, entries: { 'workflow-skills.ts': 'any', 'generated-marker.ts': 'any' }, testEntries: ['workflow-skills.ts', 'generated-marker.ts', 'render.ts'] },
];

/** Edges a rule would refuse that stay until the named change removes them. Each must match exactly `count` edges. */
const ALLOWED: Array<{ from: string; to: string; count: number; why: string }> = [
  { from: 'src/__tests__/workflow-setup.test.ts', to: 'src/workflow/place/setup.ts', count: 1, why: 'tests setup, the unit place.ts runs, directly' },
  { from: 'src/__tests__/workflow-local-driver.test.ts', to: 'src/workflow/place/worktree-snapshot.ts', count: 1, why: 'fails the snapshot a reader in the checkout takes' },
  { from: 'src/__tests__/workflow-skill-transitions.test.ts', to: 'src/workflow/drivers/skill/transitions.ts', count: 1, why: 'compares TRANSITIONS with the doc tables' },
];

const under = (file: string, folder: string): boolean => file.startsWith(folder);
const isTest = (file: string): boolean => under(file, 'src/__tests__/');
/** A workflow module outside the driver, place and discovery folders: the flat engine modules and the conformance suites. */
const isFlat = (file: string): boolean => under(file, FLAT) && ![`${FLAT}drivers/`, PLACE, DISCOVERY].some((folder) => under(file, folder));

interface RuleResult { matched: number; violations: string[] }
const show = (edge: Edge): string => `${edge.from} -> ${edge.to}`;

function rule1(edges: Edge[]): RuleResult {
  const scoped = edges.filter((edge) => under(edge.from, SKILL));
  const violations = scoped.filter((edge) => {
    if (edge.to === 'zod' || edge.to.startsWith('node:')) return false;
    if (path.posix.dirname(edge.to) === path.posix.dirname(edge.from)) return false;
    const allowed = SKILL_IMPORTS[edge.to];
    if (!allowed) return true;
    if (allowed.typeOnly && !edge.typeOnly) return true;
    const names = allowed.names;
    return names !== undefined && edge.names.some((name) => !names.includes(name));
  }).map(show);
  return { matched: scoped.length, violations };
}

function rule2(edges: Edge[]): RuleResult {
  const reached = new Set(edges.filter((edge) => under(edge.from, SKILL)).map((edge) => edge.from));
  const queue = [...reached];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    for (const edge of edges) {
      if (edge.from !== file || !edge.to.startsWith('src/') || reached.has(edge.to)) continue;
      reached.add(edge.to);
      queue.push(edge.to);
    }
  }
  return { matched: reached.size, violations: [...reached].filter((file) => under(file, LOCAL)) };
}

function rule3(edges: Edge[]): RuleResult {
  const scoped = edges.filter((edge) => ENTRIES.some(({ folder }) => under(edge.to, folder) && !under(edge.from, folder)));
  const violations = scoped.filter((edge) => {
    const guard = ENTRIES.find(({ folder }) => under(edge.to, folder));
    if (!guard) return false;
    const entry = edge.to.slice(guard.folder.length);
    if (isTest(edge.from)) return !guard.testEntries.includes(entry);
    const importers = guard.entries[entry];
    return importers === undefined || (importers !== 'any' && !importers.includes(edge.from));
  }).map(show);
  return { matched: scoped.length, violations };
}

function rule4(edges: Edge[]): RuleResult {
  const scoped = edges.filter((edge) => edge.from === `${SKILL}transitions.ts`);
  return { matched: scoped.length, violations: scoped.filter((edge) => !edge.typeOnly).map(show) };
}

function rule5(edges: Edge[]): RuleResult {
  const scoped = edges.filter((edge) => isFlat(edge.from) && under(edge.to, FLAT));
  const violations = scoped.filter((edge) => under(edge.to, `${FLAT}drivers/`) || under(edge.to, DISCOVERY)
    || (under(edge.to, PLACE) && !(edge.from === 'src/workflow/protocol.ts' && edge.to === `${PLACE}place.ts`))).map(show);
  return { matched: scoped.length, violations };
}

const RULES = { 'skill driver imports': rule1, 'nothing from the skill driver reaches the local driver': rule2, 'folders are reached through their entries': rule3, 'transitions.ts imports only types': rule4, 'flat workflow modules import no driver or discovery': rule5 };

/** The edges that `ALLOWED` names, and the entries whose count is not what the graph holds. */
function allowances(edges: Edge[]): { allowed: Set<Edge>; stale: string[] } {
  const allowed = new Set<Edge>();
  const stale: string[] = [];
  for (const entry of ALLOWED) {
    const matched = edges.filter((edge) => edge.from === entry.from && edge.to === entry.to);
    for (const edge of matched) allowed.add(edge);
    if (matched.length !== entry.count) stale.push(`${entry.from} -> ${entry.to}: ${matched.length} edges, allowed ${entry.count}`);
  }
  return { allowed, stale };
}

function stringValue(text: string): string {
  return text.slice(1, -1);
}

/** Every import, re-export, dynamic import and `vi.mock` in `source`. */
function importsOf(file: string, source: string): Edge[] {
  const parser = getParser();
  parser.setLanguage(getLanguage(file.endsWith('.tsx') ? 'tsx' : 'typescript'));
  const tree = parser.parse(source);
  if (!tree) throw new Error(`${file} did not parse`);
  const edges: Edge[] = [];
  for (const node of tree.rootNode.descendantsOfType(['import_statement', 'export_statement', 'call_expression'])) {
    if (!node) continue;
    if (node.type === 'call_expression') {
      const callee = node.childForFieldName('function')?.text;
      const first = node.childForFieldName('arguments')?.namedChildren[0];
      if ((callee === 'import' || callee === 'vi.mock') && first?.type === 'string') edges.push({ from: file, to: resolve(file, stringValue(first.text)), typeOnly: false, names: [] });
      continue;
    }
    const specifier = node.childForFieldName('source');
    if (!specifier) continue;
    const names = node.descendantsOfType(['import_specifier', 'export_specifier']).flatMap((named) => named?.childForFieldName('name')?.text ?? []);
    const clause = node.namedChildren.find((child) => child?.type === 'import_clause');
    const defaultName = clause?.namedChildren.find((child) => child?.type === 'identifier')?.text;
    edges.push({ from: file, to: resolve(file, stringValue(specifier.text)), typeOnly: /^(import|export)\s+type\s/.test(node.text), names: defaultName ? [defaultName, ...names] : names });
  }
  return edges;
}

function resolve(from: string, specifier: string): string {
  if (!specifier.startsWith('.')) return specifier;
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  const stem = joined.replace(/\.js$/, '');
  for (const candidate of [`${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`]) if (fs.existsSync(path.join(ROOT, candidate))) return candidate;
  return joined;
}

let graph: Edge[] = [];
beforeAll(async () => {
  await ensureAstReady();
  const files = fs.readdirSync(path.join(ROOT, 'src'), { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.tsx?$/.test(file) && !file.endsWith('.d.ts'))
    .map((file) => `src/${file.split(path.sep).join('/')}`);
  graph = files.flatMap((file) => importsOf(file, fs.readFileSync(path.join(ROOT, file), 'utf8')));
  // Parsing every source file takes about 5 s alone and past the default 15 s on a loaded machine.
}, 60_000);

describe('workflow module boundaries', () => {
  it.each(Object.entries(RULES))('%s', (_name, rule) => {
    const { allowed, stale } = allowances(graph);
    const { matched, violations } = rule(graph.filter((edge) => !allowed.has(edge)));
    expect(matched, 'the rule matched nothing, so it checks nothing').toBeGreaterThan(0);
    expect(violations).toEqual([]);
    expect(stale, 'an allowed edge changed: lower its count, or remove the entry').toEqual([]);
  });

  it('reads type imports, re-exports, dynamic imports and vi.mock', () => {
    const edges = importsOf('src/workflow/drivers/skill/sample.ts', [
      "import type { A } from '../../types.js';",
      "import { withRunLock, readRun as read } from '../../store.js';",
      "export { x } from './tick.js';",
      "const later = await import('../local/local-driver.js');",
      "vi.mock('../../engine.js');",
    ].join('\n'));
    expect(edges).toEqual([
      { from: 'src/workflow/drivers/skill/sample.ts', to: 'src/workflow/types.ts', typeOnly: true, names: ['A'] },
      { from: 'src/workflow/drivers/skill/sample.ts', to: 'src/workflow/store.ts', typeOnly: false, names: ['withRunLock', 'readRun'] },
      { from: 'src/workflow/drivers/skill/sample.ts', to: 'src/workflow/drivers/skill/tick.ts', typeOnly: false, names: ['x'] },
      { from: 'src/workflow/drivers/skill/sample.ts', to: 'src/workflow/drivers/local/local-driver.ts', typeOnly: false, names: [] },
      { from: 'src/workflow/drivers/skill/sample.ts', to: 'src/workflow/engine.ts', typeOnly: false, names: [] },
    ]);
  });

  it('reports each rule on a seeded violating graph', () => {
    const edge = (from: string, to: string, typeOnly = false, names: string[] = []): Edge => ({ from, to, typeOnly, names });
    const seeded = [
      edge(`${SKILL}tick.ts`, 'src/workflow/engine.ts'),
      edge(`${SKILL}tick.ts`, 'src/workflow/store.ts', false, ['readRun']),
      edge(`${SKILL}tick.ts`, 'src/workflow/protocol.ts'),
      edge('src/workflow/protocol.ts', `${LOCAL}local-driver.ts`),
      edge('src/pull.ts', `${SKILL}tick.ts`),
      edge('src/__tests__/workflow-x.test.ts', `${PLACE}reader.ts`),
      edge(`${SKILL}transitions.ts`, `${SKILL}turn.ts`),
      edge('src/workflow/engine.ts', `${DISCOVERY}render.ts`),
    ];
    expect(rule1(seeded).violations).toEqual([`${SKILL}tick.ts -> src/workflow/engine.ts`, `${SKILL}tick.ts -> src/workflow/store.ts`]);
    expect(rule2(seeded).violations).toEqual([`${LOCAL}local-driver.ts`]);
    expect(rule3(seeded).violations).toEqual([
      `src/workflow/protocol.ts -> ${LOCAL}local-driver.ts`, `src/pull.ts -> ${SKILL}tick.ts`,
      `src/__tests__/workflow-x.test.ts -> ${PLACE}reader.ts`, `src/workflow/engine.ts -> ${DISCOVERY}render.ts`,
    ]);
    expect(rule4(seeded).violations).toEqual([`${SKILL}transitions.ts -> ${SKILL}turn.ts`]);
    expect(rule5(seeded).violations).toEqual([`src/workflow/protocol.ts -> ${LOCAL}local-driver.ts`, `src/workflow/engine.ts -> ${DISCOVERY}render.ts`]);
  });
});
