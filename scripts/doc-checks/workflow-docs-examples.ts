import { readMarkdown } from './read-markdown.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import assert from 'node:assert/strict';
import { check } from '../doc-check.js';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { LeaseWireSchema } from '../../src/workflow/lease-wire.js';
import { syncScorerDefinitions } from '../../src/scorers/cache.js';
import { DefaultScorers } from '../../src/default-scorers.js';
import { formatUnknownScorer, syncScorersThenWorkflows } from '../../src/scorers/team-sync.js';
import { ciRecipesOf, runCommandsOf } from '../ci-recipe.js';
import { formatScorerDiagnostic } from '../../src/scorers/definition.js';
import { type LocalConfig } from '../../src/types.js';
import { isJsonObject, JsonValueSchema, type JsonObject, type JsonValue, JsonObjectSchema } from '@teamai/shared/json';
import { leaseNext, reportAttempt, startRun } from '../../src/workflow/engine.js';
import { formatDiagnostic } from '../../src/workflow/parse.js';
import { WORKSPACE_MODES } from '@teamai/runtime-protocol';
import type { DriverIdentity, WorkflowEnvelope } from '../../src/workflow/types.js';
import { knownSecrets } from '../../src/env-resolution.js';
import { parseSuite, type SourceFile } from '../../src/benchmark/suite.js';
import { parseDriverDefinition, SANDBOX_RUNTIME } from '../../src/workflow/runtimes/definitions.js';
import { SHIPPED_PREFIX } from '../../src/workflow/runtimes/layers.js';
import { DEFAULT_PROFILE } from '../../src/workflow/runtimes/sandbox-profiles.js';
import { engineOptions } from '../../src/workflow/runtimes/sources.js';
import { parseFleetOptions, shadowedFleetEntries } from '../../src/workflow/fleet/owner.js';
import { nestedOptions } from '../../src/workflow/runtimes/composed.js';
import { checkHostOptions } from '../../src/workflow/runtimes/host.js';
import { parseOptions as parsePaseoOptions } from '../../packages/runtime-paseo/src/options.js';
import { parseOptions as parseSandboxOptions } from '../../packages/runtime-sandbox/src/options.js';
import { parseOptions as parseT3Options } from '../../packages/runtime-t3/src/options.js';
import type { RuntimeOptions } from '@teamai/runtime-protocol';
import { RESOURCE_LAYOUTS } from '../../src/resources/resolver.js';
import { AttemptIdSchema, RunIdSchema } from '../../src/workflow/store.js';

const ROOT = process.cwd();

// docs/<dir>/**/<name>, so a new page or language is checked by default. fs.globSync needs Node 22; CI runs Node 20.
function docPages(dir: string, name: RegExp): string[] {
  return fs
    .readdirSync(path.join(ROOT, 'docs', dir), { recursive: true, encoding: 'utf8' })
    .filter((file) => name.test(path.basename(file)))
    .map((file) => path.posix.join('docs', dir, file.split(path.sep).join('/')))
    .sort();
}

const guidePages = (name: RegExp): string[] => docPages('guide', name);

const PAGES = guidePages(/^workflow.*\.md$/);
const SCORER_PAGES = guidePages(/^scorers.*\.md$/);
const BENCHMARK_PAGES = guidePages(/^benchmarks.*\.md$/);

/** Every other guide page and design note: a workflow example there passes pull too, though the page need not show one. */
const OTHER_PAGES = [...guidePages(/\.md$/), ...docPages('designs', /\.md$/)].filter((page) => !PAGES.includes(page) && !SCORER_PAGES.includes(page));

interface Example {
  label: string;
  source: string;
  /** The name an example that names no workflow is pulled under: its page and line, so each is checked and unique. */
  unnamed: string;
  /** Fenced as ```yaml fragment: a part of a file another example on the page shows whole, parsed and never pulled. */
  isFragment: boolean;
}

function examplesOf(page: string): Example[] {
  const text = readMarkdown(path.join(ROOT, page));

  return [...text.matchAll(/^```yaml( fragment)?\n([\s\S]*?)^```/gm)].map((match) => {
    const line = text.slice(0, match.index).split('\n').length + 1;
    const source = match[2] ?? '';

    return { label: `${page}:${line} (${source.split('\n')[0]?.trim()})`, source, unnamed: `docs-${page.replace(/^docs\//, '').replace(/\.md$/, '').replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}-${line}`, isFragment: match[1] !== undefined };
  });
}

function isWorkflow(value: JsonValue): value is JsonObject {
  return isJsonObject(value) && 'steps' in value;
}

/** The files a workflow example names with `prompt_file` or `answer_file`. */
function promptFiles(value: JsonValue): string[] {
  if (Array.isArray(value)) return value.flatMap(promptFiles);

  if (!isJsonObject(value)) return [];

  return Object.entries(value).flatMap(([key, field]) => {
    const file = key === 'prompt_file' || key === 'answer_file' ? z.string().safeParse(field).data : undefined;

    return file === undefined ? promptFiles(field) : [file];
  });
}

/** The workflow folder an example's first line places it in: `release` for `# workflows/release/WORKFLOW.yaml`. */
function exampleFolder(example: Example): string | undefined {
  return /^# workflows\/((?:[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+)\/WORKFLOW\.yaml\n/.exec(example.source)?.[1];
}

/**
 * Pulls a workflow folder example in a team repo of its own, as `workflows/<folder>/WORKFLOW.yaml` beside each file it
 * names, since a page may show a single-file example of the same name: what pull refused.
 */
async function folderFailures(example: Example, folder: string, value: JsonValue): Promise<string[]> {
  const config = teamRepo();
  const dir = path.join(config.repo.localPath, 'workflows', ...folder.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'WORKFLOW.yaml'), example.source);

  for (const file of promptFiles(value)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), 'Review the change.\n');
  }

  const result = await syncScorersThenWorkflows(config, { dryRun: true });

  return [
    ...result.invalid.map((diagnostic) => `${example.label}: ${formatDiagnostic(diagnostic)}`),
    ...result.unrunnable.map((file) => `${example.label}: ${file} has no runnable version`),
  ];
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
function startsOf(page: string) {
  const text = readMarkdown(path.join(ROOT, page));
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

  const unread = [...text.matchAll(/--inputs[ =]['"{]/g)].flatMap((match) => {
    const line = lineOf(match.index);

    if (starts.some((start) => start.line === line)) return [];

    // Actions expressions become JSON only inside the job; the documented CLI path has its own real-CLI E2E.
    if (text.split('\n')[line - 1]?.includes('${{')) return [];

    return [`${page}:${line}: --inputs is not part of a teamai workflow start line`];
  });

  return { starts, unread };
}

/** Each scorer file a page shows: a `scorers/<name>.md` line, then the file in a markdown fence. */
function scorerExamplesOf(page: string): Array<{ label: string; file: string; source: string }> {
  const text = readMarkdown(path.join(ROOT, page));

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
  // The roles the pages' examples run steps as.
  fs.mkdirSync(path.join(knowledge, 'manifest'));
  fs.writeFileSync(path.join(knowledge, 'manifest', 'roles.yaml'), `version: 1\nroles:\n${['review', 'spec'].map((id) => `  - id: ${id}\n    resources: { knowledge: [${id}], skills: [${id}] }\n`).join('')}`);

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

/**
 * Writes each complete single-file workflow example on `page` into the team repo, and the prompt files they name. A
 * workflow folder example is returned to pull on its own.
 */
function writeExamples(page: string, config: LocalConfig) {
  const failures: string[] = [];
  const byFile = new Map<string, string>();
  const folders: Array<{ example: Example; folder: string; value: JsonValue }> = [];

  for (const example of examplesOf(page)) {
    const document = parseDocument(example.source);

    if (document.errors.length > 0) {
      failures.push(`${example.label}: ${document.errors[0]?.message}`);
      continue;
    }

    const value: JsonValue = document.toJS();

    if (!isWorkflow(value) || example.isFragment) continue;
    const folder = exampleFolder(example);

    if (folder !== undefined) {
      folders.push({ example, folder, value });
      continue;
    }

    // An example that names no workflow is pulled under the name of its page and line, so a new one is checked too.
    const file = `workflows/${value.name === undefined ? example.unnamed : String(value.name)}.yaml`;
    const twin = byFile.get(file);

    if (twin) failures.push(`${example.label}: ${file} is also ${twin}`);
    byFile.set(file, example.label);
    fs.writeFileSync(path.join(config.repo.localPath, file), value.name === undefined ? `name: ${example.unnamed}\n${example.source}` : example.source);

    for (const prompt of promptFiles(value).filter((promptFile) => promptFile.startsWith('prompts/'))) {
      fs.mkdirSync(path.dirname(path.join(config.repo.localPath, prompt)), { recursive: true });
      fs.writeFileSync(path.join(config.repo.localPath, prompt), 'Review the change.\n');
    }
  }

  return { byFile, failures, folders };
}

const cleanup = () => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
};

const ADVANCED = PAGES.filter((page) => path.posix.basename(page) === 'workflow-advanced.md');

/** The driver the advanced page's `next` table sends. */
const scriptDriver: DriverIdentity = { kind: 'script', machine: 'host', workspace: '/work' };

const ExampleLeaseSchema = LeaseWireSchema.safeExtend({ pass: z.number() });

type Lease = z.infer<typeof ExampleLeaseSchema>;

const ExampleEnvelopeSchema = z.object({ data: JsonObjectSchema });

/** Each first group of `pattern` on `page`, parsed as JSON. */
function jsonOn(page: string, pattern: RegExp): JsonValue[] {
  return [...readMarkdown(path.join(ROOT, page)).matchAll(pattern)].map((match) =>
    JSON.parse(match[1] ?? ''),
  );
}

/** `value` with its run and attempt ids masked, which differ in every run. */
function withoutIds(value: WorkflowEnvelope | JsonValue | undefined): JsonValue {
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
  inputs: JsonValue = {},
): Promise<{ config: LocalConfig; runId: string }> {
  const config = teamRepo();
  writeExamples(page, config);
  await syncScorersThenWorkflows(config);
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

await check(
  'finds a workflow folder example on the English and Chinese workflow pages',
  () => {
    for (const page of ['docs/guide/workflow.md', 'docs/guide/zh-CN/workflow.md']) {
      assert.ok(examplesOf(page).some((example) => exampleFolder(example) !== undefined), `${page} shows no # workflows/<name>/WORKFLOW.yaml example`);
    }
  },
  cleanup,
);

await check(
  'checks the workflow examples of the other guide pages and the design notes',
  () => {
    assert.ok(OTHER_PAGES.includes('docs/guide/benchmarks.md'));
    assert.ok(OTHER_PAGES.includes('docs/designs/workflow-step-roles.md'));
  },
  cleanup,
);

for (const page of [...PAGES, ...SCORER_PAGES, ...OTHER_PAGES]) {
  await check(
    `${page}: each yaml block parses, and its complete workflows pass pull unless the page shows their failure`,
    async () => {
      const config = teamRepo();
      const { byFile, failures, folders } = writeExamples(page, config);

      if (!OTHER_PAGES.includes(page)) assert.ok((byFile.size ?? 0) > 0, `${page} has no complete workflow example`);

      for (const { example, folder, value } of folders) failures.push(...await folderFailures(example, folder, value));

      // An example may be invalid only to show a failure: the page prints its exact diagnostic as review output.
      const shown = new Set(
        [...readMarkdown(path.join(ROOT, page)).matchAll(/^\s*✖ \[workflows\] (.+)$/gm)].map(
          (match) => match[1] ?? '',
        ),
      );

      // A page with no complete workflow and no diagnostic it shows has nothing for pull to check.
      if (byFile.size === 0 && shown.size === 0) {
        assert.deepEqual(failures, []);

        return;
      }

      // The scorers a workflow example lists are the ones the scorer pages show.
      for (const example of SCORER_PAGES.flatMap(scorerExamplesOf)) {
        fs.mkdirSync(path.dirname(path.join(config.repo.localPath, example.file)), { recursive: true });
        fs.writeFileSync(path.join(config.repo.localPath, example.file), example.source);
      }

      const result = await syncScorersThenWorkflows(config, { dryRun: true });

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

      await syncScorersThenWorkflows(config);

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

        // Some inputs, such as the `after` of a for_each item, are read only when the first step is leased. It asks as
        // the local driver does, offering every workspace and taking a step's role, so an example whose first step has a role leases.
        const next = await leaseNext(config, String(started.data.run), driver, {
          can: { workspace: [...WORKSPACE_MODES], role: true },
          base: { ref: 'main', commit: 'fixture-base' },
          prepare: true,
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
        ...readMarkdown(path.join(ROOT, page))
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
        .array(z.array(z.object({ item: JsonValueSchema, outcome: z.enum(['success', 'failed']) })))
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

for (const page of [...PAGES, ...BENCHMARK_PAGES]) {
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

for (const page of [...PAGES, ...SCORER_PAGES, ...BENCHMARK_PAGES]) {
  await check(
    `${page}: every relative link to a .md file resolves`,
    () => {
      const text = readMarkdown(path.join(ROOT, page));

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
        fs.mkdirSync(path.dirname(path.join(config.repo.localPath, example.file)), { recursive: true });
        fs.writeFileSync(path.join(config.repo.localPath, example.file), example.source);
      }

      const result = await syncScorerDefinitions(config, { dryRun: true });

      assert.deepEqual(result.invalid.map(formatScorerDiagnostic), []);
      // A file named like a default scorer replaces that default, and is no scorer a step lists.
      assert.equal(result.cached.length, examples.filter(({ file }) => !DefaultScorers.isName(path.posix.basename(file, '.md'))).length);
    },
    cleanup,
  );
}

/** Each team file a page shows: a yaml fence whose first line is `# benchmarks/<path>.yaml`. */
const SUITE_FILES: ReadonlySet<string> = new Set([RESOURCE_LAYOUTS.benchmarks.marker, ...RESOURCE_LAYOUTS.benchmarks.markerAliases]);

function benchmarkFilesOf(page: string): SourceFile[] {
  return examplesOf(page).flatMap(({ source }) => {
    const relativePath = /^# (benchmarks\/\S+\.yaml)\n/.exec(source)?.[1];

    return relativePath === undefined ? [] : [{ relativePath, content: source }];
  });
}

/** The `npx teamai-cli` commands of the GitLab CI jobs a page shows: a yaml fence whose top-level job has a `script`. */
function gitlabCommandsOf(page: string): string[] {
  const JobsSchema = z.record(z.string(), z.unknown()).transform((jobs) =>
    Object.values(jobs).flatMap((job) => {
      const script = z.object({ script: z.array(z.string()) }).safeParse(job);

      return script.success ? [script.data.script] : [];
    }),
  );

  return examplesOf(page).flatMap(({ source }) => JobsSchema.parse(parseDocument(source).toJS() ?? {}).flat());
}

const teamaiCommands = (commands: string[]): string[] => commands.filter((command) => command.startsWith('npx teamai-cli '));

await check('finds the English and Chinese benchmark pages', () => {
  assert.deepEqual(BENCHMARK_PAGES, ['docs/guide/benchmarks.md', 'docs/guide/zh-CN/benchmarks.md']);
});

for (const page of BENCHMARK_PAGES) {
  await check(`${page}: each yaml block parses, and its suite and task files pass pull`, () => {
    for (const example of examplesOf(page)) assert.deepEqual(parseDocument(example.source).errors, [], example.label);
    const files = benchmarkFilesOf(page);
    const [suite, ...others] = files.filter((file) => SUITE_FILES.has(path.posix.basename(file.relativePath)));

    if (!suite || others.length > 0) throw new Error(`${page} shows ${others.length + (suite ? 1 : 0)} suite files, not one`);
    const tasks = files.filter((file) => file !== suite);
    assert.deepEqual(
      tasks.map((task) => path.posix.dirname(task.relativePath)),
      tasks.map(() => `${path.posix.dirname(suite.relativePath)}/tasks`),
      page,
    );

    const parsed = parseSuite({ suite, tasks });

    assert.deepEqual(parsed.diagnostics.map(formatDiagnostic), []);
    assert.deepEqual(parsed.ok && parsed.warnings.map(formatDiagnostic), []);
    assert.equal(parsed.ok && parsed.suite.tasks.length, tasks.length);
  });

  await check(`${page}: the GitLab CI job runs the teamai commands of the GitHub Actions job`, () => {
    const github = teamaiCommands(ciRecipesOf(path.join(ROOT, page)).flatMap(runCommandsOf));
    assert.ok(github.length > 0, `${page} shows a GitHub Actions job that runs teamai`);
    assert.deepEqual(teamaiCommands(gitlabCommandsOf(page)), github);
  });
}

await check('shows the same benchmark files and CI commands in every language', () => {
  const [english, ...others] = BENCHMARK_PAGES.map((page) => ({
    page,
    files: benchmarkFilesOf(page),
    commands: ciRecipesOf(path.join(ROOT, page)).map(runCommandsOf),
    gitlab: gitlabCommandsOf(page),
  }));

  for (const other of others) {
    assert.deepEqual(other.files, english?.files, other.page);
    assert.deepEqual(other.commands, english?.commands, other.page);
    assert.deepEqual(other.gitlab, english?.gitlab, other.page);
  }
});

/** A block's first line, `# drivers/<name>.yaml` (in any language), names the definition file it shows. */
const DEFINITION_FILE = /^#.*\bdrivers\/([A-Za-z0-9._-]+)\.yaml\b/;

type OptionsCheck = (options: RuntimeOptions) => Promise<{ ok: true } | { ok: false; failure: { key?: string; message: string } }>;

/** Each runtime teamai ships or builds in, checking a definition's options the way that runtime does at `init`. */
const RUNTIME_OPTIONS = new Map<string, OptionsCheck>([
  // `local` is the old name of `tools`; like the host runtime, neither takes options.
  ['local', async (options) => checkHostOptions(options)],
  ['tools', async (options) => checkHostOptions(options)],
  ['fleet', async (options) => parseFleetOptions(options)],
  ['sandbox', async (options) => parseSandboxOptions(options)],
  ['t3', async (options) => parseT3Options(options)],
  ['paseo', async (options) => parsePaseoOptions(options)],
]);

/**
 * The runtimes the guide defines itself, as examples of a team's own: their pages show the runtime's file or say it is
 * one you write. Any other runtime an example names must be one teamai ships, so a misspelt name fails the check.
 */
const GUIDE_RUNTIMES: ReadonlySet<string> = new Set(['toy', 'threads', 'my-app', 'my-sandbox']);

/** The runtimes teamai ships: `tools`, its old name `local`, and each `teamai-runtime-<name>` in package.json's `bin`. */
function shippedRuntimes(): string[] {
  const { bin } = z.object({ bin: z.record(z.string(), z.string()) }).parse(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')));

  return ['tools', 'local', ...Object.keys(bin).flatMap((name) => /^teamai-runtime-(.+)$/.exec(name)?.[1] ?? [])];
}

// Fails closed: a runtime teamai ships whose options this check cannot read fails it, so its guide examples are never
// let through unchecked.
await check('every runtime teamai ships has its options checked in the guide examples', () => {
  const unchecked = shippedRuntimes().filter((use) => !RUNTIME_OPTIONS.has(use));

  assert.deepEqual(unchecked.map((use) => `teamai-runtime-${use} ships, and the docs check has no options check for it: add the parseOptions of packages/runtime-${use}/src/options.ts to RUNTIME_OPTIONS`), []);
});

/**
 * Why a driver definition example would not run, or undefined. A block is one when its first line names a
 * `drivers/<name>.yaml` file, or when it lists `runtimes` and no `steps`, and it shows the whole file. Each runtime's
 * options pass what teamai reads of them (`max_parallel`, `credentials`), and the rest passes that runtime's own check
 * when teamai ships it; a team's own runtime reads its options itself.
 */
async function definitionProblem(example: Example, profiles: ReadonlyMap<string, string>): Promise<string | undefined> {
  const named = DEFINITION_FILE.exec(example.source.split('\n')[0] ?? '')?.[1];
  const document = parseDocument(example.source);
  const shown: JsonValue = document.errors.length > 0 ? null : document.toJS();
  const listsRuntimes = isJsonObject(shown) && Array.isArray(shown.runtimes) && !('steps' in shown);

  if (named === undefined && !listsRuntimes) return undefined;

  if (document.errors.length > 0) return document.errors[0]?.message;
  const parsed = parseDriverDefinition(`drivers/${named ?? (isJsonObject(shown) ? String(shown.name) : 'unnamed')}.yaml`, example.source);

  if (!parsed.ok) return parsed.failure.message;
  const [shadowed] = shadowedFleetEntries(parsed.definition.runtimes);

  if (shadowed !== undefined) return shadowed;

  for (const [index, { use, through, options, sandbox }] of parsed.definition.runtimes.entries()) {
    // An entry through another nests each runtime's options under its name, as the engine splits them at the start.
    const nested = through === undefined ? undefined : nestedOptions(options ?? {}, { inner: use, outer: through });

    if (nested?.ok === false) return `runtimes.${index} (${use} through ${through}) option ${nested.key}: ${nested.message}`;
    const parts: Array<[string, RuntimeOptions]> = nested === undefined || through === undefined ? [[use, options ?? {}]] : [[use, nested.inner], [through, nested.outer]];

    for (const [name, given] of parts) {
      const problem = name === SANDBOX_RUNTIME ? await sandboxEntryProblem(given, sandbox ?? DEFAULT_PROFILE, profiles) : await runtimeOptionsProblem(name, given);

      if (problem !== undefined) return `runtimes.${index} ${problem}`;
    }
  }

  return undefined;
}

/** Why one runtime of an entry would refuse `options` at `init`, or why the guide may not name it, or undefined. */
async function runtimeOptionsProblem(name: string, options: RuntimeOptions): Promise<string | undefined> {
  const ownCheck = RUNTIME_OPTIONS.get(name);

  if (ownCheck === undefined && !GUIDE_RUNTIMES.has(name)) return `names ${name}, a runtime teamai does not ship and the guide does not define: name a shipped runtime, or add it to GUIDE_RUNTIMES where the guide shows its file`;
  const read = engineOptions(options);

  if (!read.ok) return `(${name}) option ${read.key}: ${read.message}`;
  const own = await ownCheck?.(read.runtime);

  return own?.ok === false ? `(${name}) option ${own.failure.key ?? '?'}: ${own.failure.message}` : undefined;
}

/** A block's first line, `# sandboxes/<name>.yaml` (in any language), names the sandbox profile it shows. */
const PROFILE_FILE = /^#.*\bsandboxes\/([A-Za-z0-9._-]+)\.yaml\b/;

/** The sandbox profile `name` resolves to where the guide has shown none: teamai's own, by its name or as `teamai-<name>`. */
function shippedProfile(name: string): string | undefined {
  const file = [name, `${SHIPPED_PREFIX}${name}`].map((stem) => path.join(ROOT, 'sandboxes', `${stem}.yaml`)).find((candidate) => fs.existsSync(candidate));

  return file === undefined ? undefined : fs.readFileSync(file, 'utf8');
}

/** Why a sandbox profile's text would not start the sandbox runtime, or undefined. */
async function profileProblem(source: string): Promise<string | undefined> {
  const document = parseDocument(source);

  if (document.errors.length > 0) return document.errors[0]?.message;
  const shown: JsonValue = document.toJS();

  if (!isJsonObject(shown)) return 'a profile is a mapping such as provider: docker';
  const parsed = parseSandboxOptions(shown);

  return parsed.ok ? undefined : `option ${parsed.failure.key ?? '?'}: ${parsed.failure.message}`;
}

/**
 * Why a sandbox entry would not start, as teamai reads it: its options keep only what teamai reads of them, and the
 * profile it names (`default` when it names none) is the last one the page showed before it, or one teamai ships.
 */
async function sandboxEntryProblem(given: RuntimeOptions, name: string, profiles: ReadonlyMap<string, string>): Promise<string | undefined> {
  const read = engineOptions(given);

  if (!read.ok) return `(sandbox) option ${read.key}: ${read.message}`;
  const [inline] = Object.keys(read.runtime);

  if (inline !== undefined) return `(sandbox) option ${inline}: a sandbox's options live in a sandbox profile, which the entry names with sandbox: <name>`;
  const source = profiles.get(name) ?? shippedProfile(name);

  if (source === undefined) return `(sandbox) names sandbox profile ${name}, which no block before it on the page shows and teamai does not ship`;
  const problem = await profileProblem(source);

  return problem === undefined ? undefined : `(sandbox) profile ${name} ${problem}`;
}

/** A block's first line saying it shows a definition teamai ships, in English or Chinese: `# drivers/<name>.yaml, shipped with teamai`. */
const SHIPPED_DEFINITION = /^#\s*drivers\/([A-Za-z0-9._-]+\.yaml)(?:, shipped with teamai|，随 teamai 提供)\s*$/;

// Every definition teamai ships parses, and a guide block that says it shows one shows it as it is: word for word in
// English, and as the same YAML on a page whose comments are translated.
await check('every shipped driver definition parses, and a guide block naming it as shipped equals it', () => {
  const shipped = new Map(fs.readdirSync(path.join(ROOT, 'drivers')).filter((file) => file.endsWith('.yaml')).map((file) => [file, fs.readFileSync(path.join(ROOT, 'drivers', file), 'utf8')]));

  const unparsed = [...shipped].flatMap(([file, source]) => {
    const parsed = parseDriverDefinition(`drivers/${file}`, source);

    return parsed.ok ? [] : [`drivers/${file}: ${parsed.failure.message}`];
  });

  const differing = guidePages(/\.md$/).flatMap((page) => examplesOf(page).flatMap((example) => {
    const [heading = '', ...body] = example.source.split('\n');
    const file = SHIPPED_DEFINITION.exec(heading)?.[1];

    if (file === undefined) return [];
    const source = shipped.get(file);

    if (source === undefined) return [`${example.label}: teamai ships no drivers/${file}`];
    const shown = body.join('\n');
    const isSame = page.includes('/zh-CN/') ? isDeepStrictEqual(parseDocument(shown).toJS(), parseDocument(source).toJS()) : shown.trim() === source.trim();

    return isSame ? [] : [`${example.label}: differs from drivers/${file}`];
  }));

  assert.deepEqual([...unparsed, ...differing], []);
});

// Guide pages only: a design note may show a definition with fields it proposes.
await check('every driver definition and sandbox profile a guide page shows passes the definition schema and its runtimes\' options', async () => {
  const failures: string[] = [];

  for (const page of guidePages(/\.md$/)) {
    // A page shows a profile before the definitions that name it, and a later block of the same name replaces it.
    const profiles = new Map<string, string>();

    for (const example of examplesOf(page)) {
      const [heading = '', ...body] = example.source.split('\n');
      const profile = PROFILE_FILE.exec(heading)?.[1];

      if (profile !== undefined) {
        profiles.set(profile, body.join('\n'));
        const problem = await profileProblem(body.join('\n'));

        if (problem !== undefined) failures.push(`${example.label}: ${problem}`);
        continue;
      }

      const problem = await definitionProblem(example, profiles);

      if (problem !== undefined) failures.push(`${example.label}: ${problem}`);
    }
  }

  assert.deepEqual(failures, []);
});

/**
 * What looks like a run id (`r…`) or an attempt id (`a…`) on a guide page: hex with a digit, 8 characters or more, so a
 * git short sha of 7 is left out. Not one elided with `…`, an op id's tail (`op-…`), a UUID's first part, or the tail of
 * a hyphenated name other than a sandbox's `teamai-[<owner>-]<run>-<attempt>`, such as a worktree's hash.
 */
const SHOWN_RUN_OR_ATTEMPT_ID = /(?<![\w-])(?:(?<handle>teamai-(?:[0-9a-f]{16}-)?)(?<handleRun>r[0-9a-f]+)-(?<handleAttempt>a[0-9a-f]+)|(?<id>[ra](?=[0-9a-f]*\d)[0-9a-f]{7,}))(?![\w…-])/g;

/** Each id a guide page shows that the CLI would refuse, with its page and line, and how many it checked. */
function invalidIds(pages: readonly string[]) {
  let checked = 0;
  const invalid: string[] = [];

  for (const page of pages) {
    fs.readFileSync(path.join(ROOT, page), 'utf8').split('\n').forEach((text, index) => {
      for (const match of text.matchAll(SHOWN_RUN_OR_ATTEMPT_ID)) {
        const { handleRun, handleAttempt, id } = match.groups ?? {};

        for (const shown of [handleRun, handleAttempt, id]) {
          if (shown === undefined) continue;
          checked += 1;
          const parsed = (shown.startsWith('r') ? RunIdSchema : AttemptIdSchema).safeParse(shown);

          if (!parsed.success) invalid.push(`${page}:${index + 1}: ${shown}: ${parsed.error.issues[0]?.message}`);
        }
      }
    });
  }

  return { checked, invalid };
}

// Every guide page, in every language: a member copies a command from any of them.
await check('every run id and attempt id a guide page shows is one the CLI takes', () => {
  const { checked, invalid } = invalidIds(guidePages(/\.md$/));

  assert.ok(checked > 0, 'no guide page shows a run id or an attempt id, so the check matched nothing');
  assert.deepEqual(invalid, []);
});
