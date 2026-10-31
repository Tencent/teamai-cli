import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import assert from 'node:assert/strict';
import { check } from '../doc-check.js';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { LeaseWireSchema } from '../../src/workflow/lease-wire.js';
import { syncScorerDefinitions } from '../../src/scorers/cache.js';
import { ciRecipesOf, runCommandsOf } from '../ci-recipe.js';
import { formatScorerDiagnostic } from '../../src/scorers/definition.js';
import type { LocalConfig } from '../../src/types.js';
import { formatUnknownScorer, syncWorkflowDefinitions } from '../../src/workflow/cache.js';
import { leaseNext, reportAttempt, startRun } from '../../src/workflow/engine.js';
import { formatDiagnostic } from '../../src/workflow/parse.js';
import type { DriverIdentity, WorkflowEnvelope } from '../../src/workflow/types.js';
import { knownSecrets } from '../../src/env-resolution.js';

const ROOT = process.cwd();
const GUIDE = path.join(ROOT, 'docs', 'guide');

// docs/guide/**/workflow*.md, so a new page or language is checked by default. fs.globSync needs Node 22; CI runs Node 20.
function guidePages(name: RegExp): string[] {
  return fs
    .readdirSync(GUIDE, { recursive: true, encoding: 'utf8' })
    .filter((file) => name.test(path.basename(file)))
    .map((file) => path.posix.join('docs/guide', file.split(path.sep).join('/')))
    .sort();
}

const PAGES = guidePages(/^workflow.*\.md$/);
const SCORER_PAGES = guidePages(/^scorers.*\.md$/);

interface Example {
  label: string;
  source: string;
}

function examplesOf(page: string): Example[] {
  const text = fs.readFileSync(path.join(ROOT, page), 'utf8');
  return [...text.matchAll(/^```yaml\n([\s\S]*?)^```/gm)].map((match) => {
    const line = text.slice(0, match.index).split('\n').length + 1;
    const source = match[1] ?? '';
    return { label: `${page}:${line} (${source.split('\n')[0]?.trim()})`, source };
  });
}

function isWorkflow(value: unknown): value is { name?: unknown } {
  return !!value && typeof value === 'object' && !Array.isArray(value) && 'steps' in value;
}

function promptFiles(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(promptFiles);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, field]) =>
    key === 'prompt_file' && typeof field === 'string' ? [field] : promptFiles(field),
  );
}

/** Workflows a start line names that its page declares only in prose, as `inputs: { … }` in the same paragraph. */
const DECLARED_IN_PROSE = new Set(['fix']);

interface Start {
  label: string;
  line: number;
  name: string;
  json: string;
  paragraph: string;
}

/** Each `teamai workflow start <name> … --inputs '<json>'` on `page`, and each `--inputs` with a value it could not read as one. */
function startsOf(page: string): { starts: Start[]; unread: string[] } {
  const text = fs.readFileSync(path.join(ROOT, page), 'utf8');
  const lineOf = (index: number): number => text.slice(0, index).split('\n').length;
  const starts = [
    ...text.matchAll(/teamai workflow start ([A-Za-z0-9][A-Za-z0-9._-]*)[^\n`']*--inputs '([^'\n]*)'/g),
  ].map((match) => ({
    label: `${page}:${lineOf(match.index)} (${match[1]})`,
    line: lineOf(match.index),
    name: match[1] ?? '',
    json: match[2] ?? '',
    paragraph: text.split(/\n\s*\n/).find((block) => block.includes(match[0])) ?? '',
  }));
  const unread = [...text.matchAll(/--inputs[ =]['"{]/g)]
    .map((match) => lineOf(match.index))
    .filter((line) => !starts.some((start) => start.line === line))
    // Actions expressions become JSON only inside the job; the documented CLI path has its own real-CLI E2E.
    .filter((line) => !text.split('\n')[line - 1]?.includes('${{'))
    .map((line) => `${page}:${line}: --inputs is not part of a teamai workflow start line`);
  return { starts, unread };
}

/** Each scorer file a page shows: a `scorers/<name>.md` line, then the file in a markdown fence. */
function scorerExamplesOf(page: string): Array<{ label: string; file: string; source: string }> {
  const text = fs.readFileSync(path.join(ROOT, page), 'utf8');
  return [...text.matchAll(/^`(scorers\/[^`\n]+\.md)`[:：]\n\n```markdown\n([\s\S]*?)^```/gm)].map((match) => ({
    label: `${page}:${text.slice(0, match.index).split('\n').length}`,
    file: match[1] ?? '',
    source: match[2] ?? '',
  }));
}

const dirs: string[] = [];

function teamRepo(): LocalConfig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-workflow-docs-'));
  dirs.push(root);
  const knowledge = path.join(root, 'knowledge');
  fs.mkdirSync(path.join(knowledge, 'workflows'), { recursive: true });
  return {
    repo: { localPath: knowledge, remote: 'local', kind: 'self' },
    username: 'tester',
    scope: 'project',
    additionalRoles: [],
    projectRoot: root,
    dataHome: path.join(root, 'data'),
    usageReportEnabled: false,
  };
}

const driver: DriverIdentity = { kind: 'local', machine: 'docs', workspace: '/work' };

/** Writes each complete workflow example on `page` into the team repo, and the prompt files they name. */
function writeExamples(page: string, config: LocalConfig): { byFile: Map<string, string>; failures: string[] } {
  const failures: string[] = [];
  const byFile = new Map<string, string>();
  for (const example of examplesOf(page)) {
    const document = parseDocument(example.source);
    if (document.errors.length > 0) {
      failures.push(`${example.label}: ${document.errors[0]?.message}`);
      continue;
    }
    const value: unknown = document.toJS();
    if (!isWorkflow(value)) continue;
    const file = `workflows/${String(value.name)}.yaml`;
    const twin = byFile.get(file);
    if (twin) failures.push(`${example.label}: ${file} is also ${twin}`);
    byFile.set(file, example.label);
    fs.writeFileSync(path.join(config.repo.localPath, file), example.source);
    for (const prompt of promptFiles(value).filter((promptFile) => promptFile.startsWith('prompts/'))) {
      fs.mkdirSync(path.dirname(path.join(config.repo.localPath, prompt)), { recursive: true });
      fs.writeFileSync(path.join(config.repo.localPath, prompt), 'Review the change.\n');
    }
  }
  return { byFile, failures };
}

const cleanup = () => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
};

const ADVANCED = PAGES.filter((page) => path.posix.basename(page) === 'workflow-advanced.md');
/** The driver the advanced page's `next` table sends. */
const scriptDriver: DriverIdentity = { kind: 'script', machine: 'host', workspace: '/work' };

const ExampleLeaseSchema = LeaseWireSchema.safeExtend({ pass: z.number() });
type Lease = z.infer<typeof ExampleLeaseSchema>;
const ExampleEnvelopeSchema = z.object({ data: z.record(z.string(), z.unknown()) });

/** Each first group of `pattern` on `page`, parsed as JSON. */
function jsonOn(page: string, pattern: RegExp): unknown[] {
  return [...fs.readFileSync(path.join(ROOT, page), 'utf8').matchAll(pattern)].map((match) =>
    JSON.parse(match[1] ?? ''),
  );
}

/** `value` with its run and attempt ids masked, which differ in every run. */
function withoutIds(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value)
      .replace(/"run":"r[0-9a-f]+"/g, '"run":"<run>"')
      .replace(/"attempt":"a[0-9a-f]+"/g, '"attempt":"<attempt>"'),
  );
}

function leaseOf(answer: WorkflowEnvelope): Lease | undefined {
  return 'data' in answer && answer.data.lease !== undefined ? ExampleLeaseSchema.parse(answer.data.lease) : undefined;
}

/** Starts the workflow `name` that `page` shows. */
async function startExample(
  page: string,
  name: string,
  inputs: unknown = {},
): Promise<{ config: LocalConfig; runId: string }> {
  const config = teamRepo();
  writeExamples(page, config);
  await syncWorkflowDefinitions(config);
  const started = await startRun(config, name, inputs, { secrets: await knownSecrets(config) });
  if ('error' in started) throw new Error(`${page}: ${started.error.message}`);
  return { config, runId: String(started.data.run) };
}

/** Reports each lease with `outcome` until `next` leases nothing more, and returns every answer that leased a step. */
async function driveExample(
  config: LocalConfig,
  runId: string,
  outcome: (lease: Lease) => 'success' | 'failed',
): Promise<WorkflowEnvelope[]> {
  const answers: WorkflowEnvelope[] = [];
  for (let turn = 0; turn < 50; turn += 1) {
    const answer = await leaseNext(config, runId, scriptDriver);
    const lease = leaseOf(answer);
    if (!lease) return answers;
    answers.push(answer);
    await reportAttempt(config, runId, {
      attempt: lease.attempt,
      revision: lease.revision,
      outcome: outcome(lease),
      driver: scriptDriver,
    });
  }
  throw new Error(`run ${runId} still leases steps after 50 reports`);
}

await check(
  'finds the English and Chinese workflow pages',
  () => {
    assert.ok(PAGES.includes('docs/guide/workflow.md'));
    assert.ok(PAGES.includes('docs/guide/zh-CN/workflow.md'));
    assert.deepEqual(ADVANCED, ['docs/guide/workflow-advanced.md', 'docs/guide/zh-CN/workflow-advanced.md']);
  },
  cleanup,
);

for (const page of PAGES) {
  await check(
    `${page}: each yaml block parses, and its complete workflows pass pull unless the page shows their failure`,
    async () => {
      const config = teamRepo();
      const { byFile, failures } = writeExamples(page, config);
      assert.ok((byFile.size ?? 0) > 0, `${page} has no complete workflow example`);

      // An example may be invalid only to show a failure: the page prints its exact diagnostic as review output.
      const shown = new Set(
        [...fs.readFileSync(path.join(ROOT, page), 'utf8').matchAll(/^\s*✖ \[workflows\] (.+)$/gm)].map(
          (match) => match[1] ?? '',
        ),
      );
      // The scorers a workflow example lists are the ones the scorer pages show.
      for (const example of SCORER_PAGES.flatMap(scorerExamplesOf)) {
        fs.mkdirSync(path.join(config.repo.localPath, 'scorers'), { recursive: true });
        fs.writeFileSync(path.join(config.repo.localPath, example.file), example.source);
      }
      const result = await syncWorkflowDefinitions(config, { dryRun: true });
      for (const unknown of result.unknownScorers)
        failures.push(`${byFile.get(unknown.file) ?? page}: ${formatUnknownScorer(unknown)}`);
      const reported = new Set(result.invalid.map(formatDiagnostic));
      const shownInvalid = new Set(
        result.invalid
          .filter((diagnostic) => shown.has(formatDiagnostic(diagnostic)))
          .map((diagnostic) => diagnostic.file),
      );
      for (const diagnostic of result.invalid.filter((candidate) => !shown.has(formatDiagnostic(candidate)))) {
        failures.push(`${byFile.get(diagnostic.file) ?? page}: ${formatDiagnostic(diagnostic)}`);
      }
      for (const line of [...shown].filter((shownLine) => !reported.has(shownLine)))
        failures.push(`${page}: shows "${line}", which no example produces`);
      for (const file of result.unrunnable.filter((unrunnableFile) => !shownInvalid.has(unrunnableFile)))
        failures.push(`${byFile.get(file) ?? page}: ${file} has no runnable version`);
      assert.deepEqual(failures, []);
    },
    cleanup,
  );
}

await check(
  'finds the --inputs lines of workflow start',
  () => {
    assert.ok(
      ['fan-publish', 'fix'].every((entry) =>
        PAGES.flatMap((page) => startsOf(page).starts.map((start) => start.name)).includes(entry),
      ),
    );
  },
  cleanup,
);

await check(
  'declares in prose only workflows that a page starts without an example',
  () => {
    const inProse = new Set(
      PAGES.flatMap((page) => {
        const { byFile } = writeExamples(page, teamRepo());
        return startsOf(page)
          .starts.filter((start) => !byFile.has(`workflows/${start.name}.yaml`))
          .map((start) => start.name);
      }),
    );
    assert.deepEqual(
      [...DECLARED_IN_PROSE].filter((name) => !inProse.has(name)),
      [],
    );
  },
  cleanup,
);

for (const page of PAGES) {
  await check(
    `${page}: each workflow start --inputs fits the inputs its workflow declares on the page`,
    async () => {
      const config = teamRepo();
      const { byFile } = writeExamples(page, config);
      const { starts, unread } = startsOf(page);
      const failures = [...unread];
      const declared: Start[] = [];
      for (const start of starts) {
        if (!byFile.has(`workflows/${start.name}.yaml`)) {
          const inputs = DECLARED_IN_PROSE.has(start.name)
            ? /`inputs: (\{[^`]*\})`/.exec(start.paragraph)?.[1]
            : undefined;
          if (inputs === undefined) {
            failures.push(`${start.label}: workflow "${start.name}" is not an example on the page`);
            continue;
          }
          fs.writeFileSync(
            path.join(config.repo.localPath, 'workflows', `${start.name}.yaml`),
            `schemaVersion: v1alpha1\nname: ${start.name}\ndescription: Declared in prose.\ninputs: ${inputs}\nsteps:\n  - id: run\n    command: node run.js\n`,
          );
        }
        declared.push(start);
      }
      await syncWorkflowDefinitions(config);
      for (const start of declared) {
        let inputs: unknown;
        try {
          inputs = JSON.parse(start.json);
        } catch {
          failures.push(`${start.label}: --inputs is not JSON`);
          continue;
        }
        const started = await startRun(config, start.name, inputs, { secrets: await knownSecrets(config) });
        if ('error' in started) {
          failures.push(`${start.label}: ${started.error.code}: ${started.error.message}`);
          continue;
        }
        // Some inputs, such as the `after` of a for_each item, are read only when the first step is leased.
        const next = await leaseNext(config, String(started.data.run), driver, {
          can: { workspace: ['read-only', 'new', 'continue'] },
          base: { ref: 'main', commit: 'fixture-base' },
        });
        if (!('data' in next) || !next.data.lease)
          failures.push(`${start.label}: the first next leases nothing: ${JSON.stringify(next)}`);
      }
      assert.deepEqual(failures, []);
    },
    cleanup,
  );
}

for (const page of ADVANCED) {
  await check(
    `${page}: the next table answers what the engine answers`,
    async () => {
      const { config, runId } = await startExample(page, 'checks');
      const rows = [
        ...fs
          .readFileSync(path.join(ROOT, page), 'utf8')
          .matchAll(/^\| (.*) \| `(\{"data":\{"(?:lease|wait)".*\})` \|$/gm),
      ];
      assert.equal(rows.length, 3);
      // The table's own attempt ids, in the `running` it sends, stand for the ones this run leased.
      const attempts = new Map<string, string>();
      for (const [, fields = '', shown = ''] of rows) {
        const running = /`"running":(\[[^`]*\])`/.exec(fields)?.[1];
        const options =
          running === undefined
            ? {}
            : {
                running: z
                  .array(z.string())
                  .parse(JSON.parse(running))
                  .map((attempt) => attempts.get(attempt) ?? attempt),
              };
        const answer = await leaseNext(config, runId, scriptDriver, options);
        const expected = ExampleEnvelopeSchema.parse(JSON.parse(shown));
        const [shownLease, lease] = [leaseOf(expected), leaseOf(answer)];
        if (shownLease && lease) attempts.set(shownLease.attempt, lease.attempt);
        assert.deepEqual(withoutIds(answer), withoutIds(expected), fields);
      }
    },
    cleanup,
  );
}

for (const page of ADVANCED) {
  await check(
    `${page}: the second lease of e2e in loop-implement-task is what the engine leases`,
    async () => {
      const { config, runId } = await startExample(page, 'loop-implement-task');
      const shown = jsonOn(page, /^```text\n(\{"data":\{"lease".*\})\n```/gm);
      assert.equal(shown.length, 1);

      const answers = await driveExample(config, runId, (lease) =>
        lease.step === 'e2e' && lease.pass === 1 ? 'failed' : 'success',
      );

      assert.deepEqual(
        withoutIds(answers.filter((answer) => leaseOf(answer)?.step === 'e2e')[1]),
        withoutIds(shown[0]),
      );
    },
    cleanup,
  );
}

for (const page of ADVANCED) {
  await check(
    `${page}: the for_each results are what fan-build renders, in item order`,
    async () => {
      const [shown] = z
        .array(z.array(z.object({ item: z.unknown(), outcome: z.enum(['success', 'failed']) })))
        .parse(jsonOn(page, /^```json\n(\[.*\])\n```/gm));
      if (!shown) throw new Error(`${page} shows no results`);
      const { config, runId } = await startExample(page, 'fan-build', { packages: shown.map((entry) => entry.item) });

      const answers = await driveExample(
        config,
        runId,
        (lease) => shown[Number(/\[(\d+)\]$/.exec(lease.step)?.[1])]?.outcome ?? 'success',
      );

      const prompt = answers.map(leaseOf).find((lease) => lease?.step === 'explain')?.prompt ?? '';
      assert.deepEqual(JSON.parse(prompt.slice(prompt.indexOf('['))), shown);
    },
    cleanup,
  );
}

for (const page of PAGES) {
  await check(
    `${page}: every job of a GitHub Actions workflow it shows says what it runs on`,
    () => {
      const jobs = ciRecipesOf(path.join(ROOT, page)).flatMap((recipe) => Object.entries(recipe.jobs));
      assert.deepEqual(
        jobs.filter(([, job]) => !job['runs-on']).map(([name]) => `${page}: job ${name} has no runs-on`),
        [],
      );
    },
    cleanup,
  );
}

await check(
  'shows the same CI recipe commands in every language',
  () => {
    const recipes = PAGES.filter((page) => path.posix.basename(page) === 'workflow.md').map((page) => ({
      page,
      commands: ciRecipesOf(path.join(ROOT, page)).map(runCommandsOf),
    }));
    assert.deepEqual(
      recipes.map(({ page }) => page),
      ['docs/guide/workflow.md', 'docs/guide/zh-CN/workflow.md'],
    );
    assert.ok((recipes[0]?.commands.flat().length ?? 0) > 0, 'the English guide shows a CI recipe with run commands');
    for (const { page, commands } of recipes.slice(1)) assert.deepEqual(commands, recipes[0]?.commands, page);
  },
  cleanup,
);

for (const page of [...PAGES, ...SCORER_PAGES]) {
  await check(
    `${page}: every relative link to a .md file resolves`,
    () => {
      const text = fs.readFileSync(path.join(ROOT, page), 'utf8');
      const missing = [...text.matchAll(/\]\(([^)#\s:]+\.md)(?:#[^)]*)?\)/g)]
        .flatMap((match) => match[1] ?? [])
        .filter((target) => !fs.existsSync(path.join(ROOT, path.dirname(page), target)));
      assert.deepEqual(missing, []);
    },
    cleanup,
  );
}

await check(
  'finds the English and Chinese scorer pages',
  () => {
    assert.deepEqual(SCORER_PAGES, ['docs/guide/scorers.md', 'docs/guide/zh-CN/scorers.md']);
  },
  cleanup,
);

for (const page of SCORER_PAGES) {
  await check(
    `${page}: each scorer file passes pull`,
    async () => {
      const config = teamRepo();
      const examples = scorerExamplesOf(page);
      assert.ok((examples.length ?? 0) > 0, `${page} has no scorer example`);
      for (const example of examples) {
        fs.mkdirSync(path.join(config.repo.localPath, 'scorers'), { recursive: true });
        fs.writeFileSync(path.join(config.repo.localPath, example.file), example.source);
      }

      const result = await syncScorerDefinitions(config, { dryRun: true });

      assert.deepEqual(result.invalid.map(formatScorerDiagnostic), []);
      assert.equal(result.cached.length, examples.length);
    },
    cleanup,
  );
}
