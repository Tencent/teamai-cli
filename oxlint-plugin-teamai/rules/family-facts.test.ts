import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ruleHarness } from '../test/harness.ts';
import { FACTS_FILES, isFactsModule, startupEntries } from './family-facts.js';
import { FAMILY } from '../utils.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const rule = ruleHarness('teamai/family-facts', { filename: 'src/index.ts' });

const manifest = (name: string, exports: Record<string, string>) => JSON.stringify({ name, private: true, exports });

/** A workspace with one family, `tool-acme`, whose facts entry holds data and whose index holds its adapters. */
const workspace = {
  'package.json': JSON.stringify({ name: 'teamai-cli', workspaces: ['packages/*'], bin: { teamai: 'dist/index.js', 'teamai-runtime-acme': 'dist/runtime-acme.js' } }),
  'tsup.config.ts': `export default defineConfig({\n  entry: {\n    index: 'src/bin.ts',\n    cli: 'src/index.ts',\n    'runtime-acme': 'packages/runtime-acme/src/main.ts',\n  },\n});\n`,
  'src/bin.ts': `await import(new URL('./cli.js', import.meta.url).href);\n`,
  'src/index.ts': `program\n  .command('hook-dispatch <event>')\n  .action(async () => { const { hookDispatchCli } = await import('./hook-dispatch-cli.js'); await hookDispatchCli(); });\nprogram\n  .command('pull')\n  .action(async () => { const { pull } = await import('./pull.js'); await pull(); });\nprogram\n  .command('pull-requests')\n  .action(async () => { await import('./pull-requests.js'); });\nprogram\n  .command('doctor')\n  .action(async () => { await import('./doctor.js'); });\n`,
  'src/doctor.ts': 'export {};\n',
  'packages/runtime-acme/src/main.ts': `import { LAUNCH } from '../../../src/launch-registry.js';\nexport const main = LAUNCH;\n`,
  'packages/tool-definitions/package.json': manifest('@teamai/tool-definitions', { '.': './src/registry.ts', './facts': './src/facts.ts' }),
  'packages/tool-definitions/src/registry.ts': `import { family as acme } from '@teamai/tool-acme';\nexport const BUILT_IN_TOOLS = { acme };\n`,
  'packages/tool-definitions/src/facts.ts': `import { facts as acme } from '@teamai/tool-acme/facts';\nexport const BUILT_IN_FACTS = { acme };\n`,
  'packages/tool-acme/package.json': manifest('@teamai/tool-acme', { '.': './src/index.ts', './facts': './src/facts.ts' }),
  'packages/tool-acme/src/index.ts': `import { platforms } from './sessions.js';\nexport const family = { platforms };\n`,
  'packages/tool-acme/src/sessions.ts': `import { AcmeAdapter } from './session-adapter.js';\nexport const platforms = { acme: { adapter: () => new AcmeAdapter() } };\n`,
  'packages/tool-acme/src/session-adapter.ts': 'export class AcmeAdapter {}\n',
  'packages/tool-acme/src/facts.ts': `import { tools } from './definitions.js';\nexport const facts = { tools };\n`,
  'packages/tool-acme/src/definitions.ts': 'export const tools = { acme: {} };\n',
  'packages/tool-core/package.json': manifest('@teamai/tool-core', { './definition': './src/definition.ts', './formats/*': './src/formats/*.ts' }),
  'packages/tool-core/src/definition.ts': 'export const UNKNOWN = "unknown";\n',
  'packages/tool-core/src/formats/claude-jsonl.ts': 'export const schema = {};\n',
  'src/tools.ts': `import { BUILT_IN_FACTS } from '@teamai/tool-definitions/facts';\nexport const TOOLS = { acme: BUILT_IN_FACTS.acme.tools.acme };\n`,
  'src/tools-from-registry.ts': `import { BUILT_IN_TOOLS } from '@teamai/tool-definitions';\nexport const TOOLS = BUILT_IN_TOOLS;\n`,
  'src/hooks.ts': `import { TOOLS } from './tools.js';\nexport const hooks = TOOLS;\n`,
  'src/stale-hooks.ts': `import { TOOLS } from './tools-from-registry.js';\nexport const hooks = TOOLS;\n`,
  'src/launch-registry.ts': `import { BUILT_IN_TOOLS } from '@teamai/tool-definitions';\nexport const LAUNCH = BUILT_IN_TOOLS;\n`,
  'src/hook-dispatch-cli.ts': `export async function hookDispatchCli() { await import('./session-flow/captures.js'); }\n`,
  'src/session-flow/captures.ts': 'export {};\n',
  'src/pull.ts': `export async function pull() { await import('./pull-checks.js'); }\n`,
  'src/pull-checks.ts': 'export {};\n',
  'src/pull-requests.ts': 'export {};\n',
};
/** `code` in the CLI, beside the commands it declares. */
const atCli = (code: string) => `${code}\n${workspace['src/index.ts']}`;
/** The workspace around a fixture at `filename`, without the workspace's own copy of that file. */
const inWorkspace = (filename: string) => ({ filename, files: Object.fromEntries(Object.entries(workspace).filter(([file]) => file !== filename)) });

describe('teamai/family-facts', () => {
  describe('the startup entries', () => {
    rule.invalid('refuses the CLI entry when an import reaches a family\'s behaviour through the list of families', atCli(`import { hooks } from './stale-hooks.js';`), (output) => {
      expect(output).toContain('src/index.ts -> src/stale-hooks.ts -> src/tools-from-registry.ts -> packages/tool-definitions/src/registry.ts');
      expect(output).toContain('@teamai/tool-definitions/facts');
    }, inWorkspace('src/index.ts'));
    rule.invalid('refuses the hook dispatch too', `import { LAUNCH } from './launch-registry.js';`, (output) => {
      expect(output).toContain('src/hook-dispatch-cli.ts loads at startup or before a hook or pull an agent waits on ends');
    }, inWorkspace('src/hook-dispatch-cli.ts'));
    rule.invalid('refuses a re-export that reaches a family\'s adapters', atCli(`export { platforms } from '@teamai/tool-acme';`), undefined, inWorkspace('src/index.ts'));
    rule.valid('allows an entry whose imports reach only facts', atCli(`import { hooks } from './hooks.js';\nimport { UNKNOWN } from '@teamai/tool-core/definition';`), inWorkspace('src/index.ts'));
    rule.valid('allows a dynamic import, which loads the behaviour on first use', atCli(`const { LAUNCH } = await import('./launch-registry.js');`), inWorkspace('src/index.ts'));
    rule.valid('allows a type-only import, which the build erases', atCli(`import type { LAUNCH } from './launch-registry.js';`), inWorkspace('src/index.ts'));
    rule.valid('leaves a module that is not a startup entry alone', `import { LAUNCH } from './launch-registry.js';`, inWorkspace('src/doctor.ts'));
    rule.invalid('refuses the executable, which loads the CLI by URL', `import { LAUNCH } from './launch-registry.js';\nawait import(new URL('./cli.js', import.meta.url).href);`, (output) => {
      expect(output).toContain('src/bin.ts -> src/launch-registry.ts -> packages/tool-definitions/src/registry.ts');
    }, inWorkspace('src/bin.ts'));
    rule.invalid('refuses a module the hook dispatch loads with import() before its hook answers', `import { LAUNCH } from '../launch-registry.js';`, undefined, inWorkspace('src/session-flow/captures.ts'));
    rule.invalid('refuses the pull, which an agent waits on as it waits on a hook', `import { LAUNCH } from './launch-registry.js';`, (output) => {
      expect(output).toContain('src/pull.ts -> src/launch-registry.ts');
    }, inWorkspace('src/pull.ts'));
    rule.invalid('refuses a module the pull loads with import() before it ends', `import { LAUNCH } from './launch-registry.js';`, undefined, inWorkspace('src/pull-checks.ts'));
    rule.valid('leaves a command whose name only starts with pull alone', `import { LAUNCH } from './launch-registry.js';`, inWorkspace('src/pull-requests.ts'));
    rule.invalid('refuses a family\'s behaviour the pull loads with import() by its package name', `export async function pull() { await import('@teamai/tool-acme'); }`, (output) => {
      expect(output).toContain('src/pull.ts -> packages/tool-acme/src/index.ts');
    }, inWorkspace('src/pull.ts'));
    rule.invalid('finds the pull however the CLI quotes its name and its module', `import { LAUNCH } from './launch-registry.js';`, undefined, {
      filename: 'src/pull.ts',
      files: { ...inWorkspace('src/pull.ts').files, 'src/index.ts': `program\n  .command("hook-dispatch <event>")\n  .action(async () => { await import("./hook-dispatch-cli.js"); });\nprogram\n  .command(\`pull\`)\n  .action(async () => { await import(\`./pull.js\`); });\n` },
    });
    rule.invalid('holds a new step of the hook dispatch, with no rule edit', `import { LAUNCH } from './launch-registry.js';`, (output) => {
      expect(output).toContain('src/new-hook-step.ts -> src/launch-registry.ts');
    }, { filename: 'src/new-hook-step.ts', files: { ...workspace, 'src/hook-dispatch-cli.ts': `export async function hookDispatchCli() { await import('./new-hook-step.js'); }\n` } });
    rule.invalid('holds a new executable package.json names, with no rule edit', `import { LAUNCH } from './launch-registry.js';`, (output) => {
      expect(output).toContain('src/acme.ts -> src/launch-registry.ts');
    }, {
      filename: 'src/acme.ts',
      files: {
        ...workspace,
        'package.json': JSON.stringify({ name: 'teamai-cli', workspaces: ['packages/*'], bin: { teamai: 'dist/index.js', 'teamai-acme': 'dist/acme.js' } }),
        'tsup.config.ts': `export default defineConfig({\n  entry: {\n    index: 'src/bin.ts',\n    cli: 'src/index.ts',\n    acme: 'src/acme.ts',\n  },\n});\n`,
      },
    });
    rule.valid('leaves a step runtime\'s executable to load the tools it launches', `import { LAUNCH } from '../../../src/launch-registry.js';\nexport const main = LAUNCH;`, inWorkspace('packages/runtime-acme/src/main.ts'));

    it('refuses an executable whose bundle tsup.config.ts does not name, rather than leaving it unchecked', () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'family-facts-bin-'));

      try {
        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ bin: { teamai: 'dist/index.js', 'teamai-new': 'dist/new.js' } }));
        fs.writeFileSync(path.join(root, 'tsup.config.ts'), `export default defineConfig({\n  entry: {\n    index: 'src/bin.ts',\n  },\n});\n`);

        expect(() => startupEntries(root)).toThrow('package.json bin dist/new.js names no entry of tsup.config.ts');
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it.each([
      ['declares no pull', `program\n  .command('hook-dispatch <event>')\n  .action(async () => { await import('./hook-dispatch-cli.js'); });\n`, 'declares no pull command'],
      ['loads the pull\'s module in no import()', `import { pull } from './pull.js';\nprogram\n  .command('hook-dispatch <event>')\n  .action(async () => { await import('./hook-dispatch-cli.js'); });\nprogram\n  .command('pull')\n  .action(pull);\n`, 'its pull command loads no module with import()'],
    ])('refuses a CLI that %s, rather than leaving the pull unchecked', (_, cli, message) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'family-facts-cli-'));

      try {
        for (const [file, text] of Object.entries({ ...workspace, 'src/index.ts': cli })) {
          fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
          fs.writeFileSync(path.join(root, file), text);
        }

        expect(() => startupEntries(root)).toThrow(message);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('the facts modules', () => {
    rule.invalid('refuses a family\'s facts entry importing its session adapters', `import { platforms } from './sessions.js';\nexport const facts = { platforms };`, (output) => {
      expect(output).toContain('packages/tool-acme/src/facts.ts is a facts module');
    }, inWorkspace('packages/tool-acme/src/facts.ts'));
    rule.invalid('refuses a family\'s definitions importing a shared format', `import { schema } from '@teamai/tool-core/formats/claude-jsonl';\nexport const tools = { schema };`, undefined, inWorkspace('packages/tool-acme/src/definitions.ts'));
    rule.invalid('refuses platform-facts reading the list of families', `import { BUILT_IN_TOOLS } from '@teamai/tool-definitions';\nexport const SESSION_PLATFORM_FACTS = BUILT_IN_TOOLS;`, undefined, inWorkspace('src/session-flow/adapters/platform-facts.ts'));
    rule.invalid('refuses the list of facts importing a family\'s index', `import { family } from '@teamai/tool-acme';\nexport const BUILT_IN_FACTS = { acme: family };`, undefined, inWorkspace('packages/tool-definitions/src/facts.ts'));
    rule.invalid('refuses a dynamic import in a facts module', `export const later = () => import('./sessions.js');`, undefined, inWorkspace('packages/tool-acme/src/facts.ts'));
    rule.invalid('refuses a dependency in a facts module', `import { z } from 'zod';\nexport const tools = { z };`, undefined, inWorkspace('packages/tool-acme/src/definitions.ts'));
    rule.invalid('holds the facts entry of a family in a new package, with no rule edit', `import { launch } from './launch.js';\nexport const facts = { launch };`, (output) => {
      expect(output).toContain('packages/tool-newcomer/src/facts.ts is a facts module');
    }, inWorkspace('packages/tool-newcomer/src/facts.ts'));
    rule.valid('allows a family\'s facts entry to import its definitions and tool-core\'s definition', `import { tools } from './definitions.js';\nimport { UNKNOWN } from '@teamai/tool-core/definition';\nimport type { AcmeAdapter } from './session-adapter.js';\nexport const facts = { tools, UNKNOWN };`, inWorkspace('packages/tool-acme/src/facts.ts'));
    rule.valid('allows the list of facts to import each family\'s facts entry', `import { facts as acme } from '@teamai/tool-acme/facts';\nexport const BUILT_IN_FACTS = { acme };`, inWorkspace('packages/tool-definitions/src/facts.ts'));
    rule.valid('leaves a family\'s behaviour modules to import what they need', `import { AcmeAdapter } from './session-adapter.js';\nexport const platforms = { AcmeAdapter };`, inWorkspace('packages/tool-acme/src/sessions.ts'));
    rule.valid('leaves tool-core and tool-launch out of the families', `import { z } from 'zod';\nexport const facts = { z };`, inWorkspace('packages/tool-launch/src/facts.ts'));
  });

  describe('in this checkout', () => {
    const families = fs.readdirSync(path.join(REPO, 'packages')).filter((folder) => FAMILY.test(folder));

    it('holds every family\'s facts entry and definitions, so the rule matches files here', () => {
      const matched = families.flatMap((folder) => ['facts', 'definitions'].map((name) => `packages/${folder}/src/${name}.ts`)).filter((file) => fs.existsSync(path.join(REPO, file)));

      expect(families.length).toBeGreaterThan(0);
      expect(matched.length).toBe(families.length * 2);
      expect(matched.every(isFactsModule)).toBe(true);
    });

    it('names only files that exist in FACTS_FILES', () => {
      expect([...FACTS_FILES].filter((file) => !fs.existsSync(path.join(REPO, file)))).toEqual([]);
    });

    it('finds the startup entries from the executables, the CLI and its hook and pull commands, the ones a list named before among them', () => {
      const entries = [...startupEntries(REPO)];

      expect(entries).toEqual(expect.arrayContaining(['src/bin.ts', 'src/index.ts', 'src/hook-dispatch-cli.ts', 'src/dashboard-collector.ts', 'src/session-flow/captures.ts', 'src/pull.ts', 'src/doctor.ts']));
      expect(entries.filter((file) => !fs.existsSync(path.join(REPO, file)))).toEqual([]);
    });
  });
});
