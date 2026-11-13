import { expect } from 'vitest';

import { ruleHarness } from '../test/harness.ts';

const rule = ruleHarness('teamai/package-boundaries', { filename: 'packages/tool-core/src/sessions.ts' });

const workspace = {
  'package.json': JSON.stringify({ name: 'teamai-cli', workspaces: ['packages/*'], dependencies: { zod: '^4.0.0' } }),
  'packages/tool-core/package.json': JSON.stringify({ name: '@teamai/tool-core', private: true }),
  'packages/tool-core/src/definition.ts': 'export const definition = 1;',
  'packages/runtime-sandbox/package.json': JSON.stringify({ name: '@teamai/runtime-sandbox', private: true }),
  'packages/runtime-protocol/package.json': JSON.stringify({ name: '@teamai/runtime-protocol', private: true }),
  'packages/runtime-kit/package.json': JSON.stringify({ name: '@teamai/runtime-kit', private: true }),
  'packages/runtime-testing/package.json': JSON.stringify({ name: '@teamai/runtime-testing', private: true }),
  'packages/runtime-t3/package.json': JSON.stringify({ name: '@teamai/runtime-t3', private: true }),
  'packages/runtime-tools/package.json': JSON.stringify({ name: '@teamai/runtime-tools', private: true }),
  'packages/shared/package.json': JSON.stringify({ name: '@teamai/shared', private: true }),
  'packages/tool-claude/package.json': JSON.stringify({ name: '@teamai/tool-claude', private: true }),
  'packages/tool-codex/package.json': JSON.stringify({ name: '@teamai/tool-codex', private: true }),
  'packages/tool-definitions/package.json': JSON.stringify({ name: '@teamai/tool-definitions', private: true }),
  'packages/tool-testing/package.json': JSON.stringify({ name: '@teamai/tool-testing', private: true }),
  'src/locate.ts': 'export const locate = 1;',
  'scripts/check-docs.mjs': 'export const check = 1;',
};
const inWorkspace = (filename: string, files: Readonly<Record<string, string>> = {}) => ({ filename, files: { ...workspace, ...files } });

rule.invalid('rejects a package importing src/', `import { locate } from '../../../src/locate.js';`, (output) => {
  expect(output).toContain('A workspace package imports only its own files and other workspace packages by name');
  expect(output).toContain('packages/tool-core/src/sessions.ts -> src/locate.js');
}, inWorkspace('packages/tool-core/src/sessions.ts'));

rule.invalid('rejects a type-only import of src/ from a package', `import type { Locate } from '../../../src/locate.js';`, undefined, inWorkspace('packages/tool-core/src/sessions.ts'));

rule.invalid('rejects a package test importing src/', `import { locate } from '../../../src/locate.js';`, undefined, inWorkspace('packages/tool-core/src/sessions.test.ts'));

rule.invalid('rejects a package importing a repository script', `import { check } from '../../../scripts/check-docs.mjs';`, undefined, inWorkspace('packages/tool-core/src/sessions.ts'));

rule.invalid('rejects a package mocking src/', `vi.mock('../../../src/locate.js');`, undefined, inWorkspace('packages/tool-core/src/sessions.test.ts'));

rule.invalid('rejects a relative import into another package', `import { definition } from '../../tool-core/src/definition.js';`, (output) => {
  expect(output).toContain('Import a workspace package by its package name');
  expect(output).toContain('@teamai/tool-core');
}, inWorkspace('packages/runtime-sandbox/src/index.ts'));

rule.invalid('rejects a relative import from src/ into a package', `import { definition } from '../packages/tool-core/src/definition.js';`, (output) => {
  expect(output).toContain('@teamai/tool-core');
}, inWorkspace('src/tools.ts'));

rule.invalid('rejects src/ importing a runtime package', `import { runtime } from '@teamai/runtime-sandbox';`, (output) => {
  expect(output).toContain('src/ never imports a runtime package');
  expect(output).toContain('src/workflow/engine.ts -> @teamai/runtime-sandbox');
}, inWorkspace('src/workflow/engine.ts'));

rule.invalid('rejects src/ importing a runtime package subpath', `export { runtime } from '@teamai/runtime-sandbox/protocol';`, undefined, inWorkspace('src/workflow/engine.ts'));

rule.invalid('rejects src/ loading a runtime package dynamically', `export const load = () => import('@teamai/runtime-sandbox');`, undefined, inWorkspace('src/workflow/engine.ts'));

rule.invalid('rejects a unit test importing a runtime package', `vi.mock('@teamai/runtime-sandbox');`, undefined, inWorkspace('src/__tests__/engine.test.ts'));

rule.invalid('rejects a file in a package that is not private', `export const definition = 1;`, (output) => {
  expect(output).toContain('A workspace package is private');
  expect(output).toContain('packages/tool-public/package.json');
}, inWorkspace('packages/tool-public/src/index.ts', { 'packages/tool-public/package.json': JSON.stringify({ name: '@teamai/tool-public' }) }));

rule.invalid('rejects a file in a packages/ folder with no package.json', `export const definition = 1;`, (output) => {
  expect(output).toContain('packages/tool-orphan/package.json');
}, inWorkspace('packages/tool-orphan/src/index.ts'));

rule.invalid('rejects a family importing another family', `import { family } from '@teamai/tool-codex';`, (output) => {
  expect(output).toContain('Only @teamai/tool-definitions imports a tool family');
  expect(output).toContain('packages/tool-claude/src/index.ts -> @teamai/tool-codex');
}, inWorkspace('packages/tool-claude/src/index.ts'));

rule.invalid('rejects src/ importing a family', `import { family } from '@teamai/tool-claude';`, undefined, inWorkspace('src/tools.ts'));

rule.invalid('rejects a unit test mocking a family', `vi.mock('@teamai/tool-claude');`, undefined, inWorkspace('src/__tests__/tools.test.ts'));

rule.invalid('rejects tool-core importing a family', `import { family } from '@teamai/tool-claude';`, undefined, inWorkspace('packages/tool-core/src/registry.ts'));

rule.invalid('rejects production code importing the test kit', `import { describeFamily } from '@teamai/tool-testing/conformance';`, (output) => {
  expect(output).toContain('@teamai/tool-testing is test-only');
}, inWorkspace('packages/tool-claude/src/index.ts'));

rule.valid('allows tool-definitions importing every family', `import { family as claude } from '@teamai/tool-claude';
import { family as codex } from '@teamai/tool-codex';`, inWorkspace('packages/tool-definitions/src/registry.ts'));

rule.valid('allows a family test importing the test kit', `import { describeFamily } from '@teamai/tool-testing/conformance';`, inWorkspace('packages/tool-claude/src/conformance.test.ts'));

rule.valid("allows a test importing a family's test-only recordings", `import { claudeFake } from '@teamai/tool-claude/testing';`, inWorkspace('src/__tests__/e2e/codebase-enrich-workflow.test.ts'));

rule.valid("allows the test kit's tests importing a family's test-only recordings", `import { claudeFake } from '@teamai/tool-claude/testing';`, inWorkspace('packages/tool-testing/src/fake-agent.test.ts'));

rule.invalid("rejects production code importing a family's test-only recordings", `import { claudeFake } from '@teamai/tool-claude/testing';`, (output) => {
  expect(output).toContain("@teamai/tool-claude/testing is test-only");
}, inWorkspace('src/tools.ts'));

rule.invalid("rejects a family's own product code importing its test-only recordings", `import { claudeFake } from '@teamai/tool-claude/testing';`, (output) => {
  expect(output).toContain('@teamai/tool-claude/testing is test-only');
}, inWorkspace('packages/tool-claude/src/index.ts'));

rule.invalid("rejects a package's product code importing its own src/testing/", `import { suite } from './testing/suite.js';`, (output) => {
  expect(output).toContain('packages/runtime-t3/src/testing/suite.js is test support');
}, inWorkspace('packages/runtime-t3/src/runtime.ts'));

rule.valid("allows a package's test importing its own src/testing/", `import { suite } from './testing/suite.js';`, inWorkspace('packages/runtime-t3/src/runtime.test.ts'));

rule.valid("allows a package's src/testing/ importing more of its own test support", `import { suite } from './suite.js';`, inWorkspace('packages/runtime-t3/src/testing/harness.ts'));

rule.invalid("rejects a family's test importing another family's recordings", `import { codexFake } from '@teamai/tool-codex/testing';`, undefined, inWorkspace('packages/tool-claude/src/testing/fake-agent.test.ts'));

rule.invalid('still rejects a test importing the rest of a family', `import { family } from '@teamai/tool-claude';`, undefined, inWorkspace('src/__tests__/e2e/codebase-enrich-workflow.test.ts'));

rule.valid('allows a package importing its own files', `import { definition } from './definition.js';`, inWorkspace('packages/tool-core/src/sessions.ts'));

rule.valid('allows a package importing another package by name', `import { definition } from '@teamai/tool-core/definition';`, inWorkspace('packages/runtime-sandbox/src/index.ts'));

rule.valid('allows src/ importing the runtime teamai runs in its own process', `import { toolsStepRuntime } from '@teamai/runtime-tools';`, inWorkspace('src/workflow/runtimes/sources.ts'));

rule.invalid('rejects src/ importing a runtime that runs as its own executable', `import { runtime } from '@teamai/runtime-sandbox';`, (output) => {
  expect(output).toContain('src/ never imports a runtime package but @teamai/runtime-tools');
  expect(output).toContain('src/x.ts -> @teamai/runtime-sandbox');
}, inWorkspace('src/x.ts'));

rule.valid('allows src/ importing the runtime protocol', `import { RuntimeRequestSchema } from '@teamai/runtime-protocol';`, inWorkspace('src/workflow/runtimes/stdio.ts'));

rule.valid('allows a runtime package importing the runtime protocol', `import { RuntimeRequestSchema } from '@teamai/runtime-protocol';`, inWorkspace('packages/runtime-sandbox/src/main.ts'));

rule.invalid('still rejects src/ importing a runtime package beside the protocol', `import { RuntimeRequestSchema } from '@teamai/runtime-protocol';
import { runtime } from '@teamai/runtime-sandbox';`, (output) => {
  expect(output).toContain('src/workflow/runtimes/stdio.ts -> @teamai/runtime-sandbox');
  expect(output).not.toContain('-> @teamai/runtime-protocol');
}, inWorkspace('src/workflow/runtimes/stdio.ts'));

rule.invalid('rejects src/ importing a runtime package whose name only starts like the protocol', `import { runtime } from '@teamai/runtime-protocol-next';`, undefined, inWorkspace('src/workflow/engine.ts', {
  'packages/runtime-protocol-next/package.json': JSON.stringify({ name: '@teamai/runtime-protocol-next', private: true }),
}));

rule.valid('allows src/ importing a package that is not a runtime', `import { definition } from '@teamai/tool-core/definition';`, inWorkspace('src/tools.ts'));

rule.valid('allows src/ importing src/', `import { locate } from './locate.js';`, inWorkspace('src/tools.ts'));

rule.valid('leaves a checkout without workspaces alone', `import { locate } from '../../../src/locate.js';`, { filename: 'packages/tool-core/src/sessions.ts' });

rule.invalid('rejects src/ importing a value from a package teamai-cli does not depend on, which the bundle would carry', `import { DaemonClient } from '@getpaseo/server';`, (output) => {
  expect(output).toContain('src/ imports values only from Node, the workspace packages and the dependencies in package.json');
  expect(output).toContain('@getpaseo/server');
}, inWorkspace('src/workflow/runtimes/sources.ts'));

rule.invalid('rejects src/ loading a package teamai-cli does not depend on at run time', `const ws = await import('ws');`, undefined, inWorkspace('src/workflow/runtimes/sources.ts'));

rule.invalid('rejects src/ importing a file of an npm package whose name is also a Node module', `import { StringDecoder } from 'string_decoder/lib/string_decoder.js';`, undefined, inWorkspace('src/workflow/runtimes/sources.ts'));

rule.invalid('rejects src/ re-exporting a value of a package teamai-cli does not depend on', `export { WebSocket } from 'ws';`, undefined, inWorkspace('src/workflow/runtimes/sources.ts'));

rule.valid('allows src/ to import only the types of a package teamai-cli does not depend on', `import type { DaemonClient } from '@getpaseo/server';`, inWorkspace('src/workflow/runtimes/sources.ts'));

rule.valid('allows src/ a dependency, a subpath of one, Node and a workspace package', [
  `import { z } from 'zod';`, `import { toJSONSchema } from 'zod/v4';`, `import fs from 'node:fs';`, `import path from 'path';`, `import { readFile } from 'fs/promises';`, `import { definition } from '@teamai/tool-core';`,
].join('\n'), inWorkspace('src/workflow/runtimes/sources.ts'));

rule.valid('allows a src/ test a package teamai-cli does not ship', `import { WebSocket } from 'ws';`, inWorkspace('src/__tests__/paseo.test.ts'));

rule.invalid('rejects src/ requiring a runtime package', `export const runtime = require('@teamai/runtime-sandbox');`, (output) => {
  expect(output).toContain('src/ never imports a runtime package');
}, inWorkspace('src/workflow/engine.ts'));

rule.invalid('rejects a package requiring src/', `export const locate = require('../../../src/locate.js');`, (output) => {
  expect(output).toContain('packages/tool-core/src/sessions.ts -> src/locate.js');
}, inWorkspace('packages/tool-core/src/sessions.ts'));

rule.invalid('rejects src/ loading a runtime package through a template with no placeholder', 'export const load = () => import(`@teamai/runtime-sandbox`);', (output) => {
  expect(output).toContain('src/ never imports a runtime package');
}, inWorkspace('src/workflow/engine.ts'));

rule.invalid('rejects src/ loading a module whose name is computed, since its side cannot be checked', 'export const load = (name: string) => import(`@teamai/runtime-${name}`);', (output) => {
  expect(output).toContain('computed');
}, inWorkspace('src/workflow/engine.ts'));

rule.invalid('rejects a package requiring a module whose name is computed', 'export const load = (name: string) => require(name);', (output) => {
  expect(output).toContain('computed');
}, inWorkspace('packages/tool-core/src/sessions.ts'));

rule.valid('allows a package requiring a Node module', `export const fs = require('node:fs');`, inWorkspace('packages/tool-core/src/sessions.ts'));

rule.valid('allows a call of a require that takes no module name', `export const resolved = require.resolve('zod');`, inWorkspace('src/workflow/engine.ts'));

rule.valid('leaves a test computing what it loads alone', 'export const load = (name: string) => import(`./fixtures/${name}.js`);', inWorkspace('src/__tests__/engine.test.ts'));

rule.valid('allows a runtime importing the kit', `import { serveRuntime } from '@teamai/runtime-kit/serve';`, inWorkspace('packages/runtime-t3/src/runtime.ts'));

rule.invalid('rejects a runtime importing another runtime', `import { runtime } from '@teamai/runtime-sandbox';`, (output) => {
  expect(output).toContain('A runtime package imports no other runtime but the protocol, the kit');
  expect(output).toContain('packages/runtime-t3/src/x.ts -> @teamai/runtime-sandbox');
}, inWorkspace('packages/runtime-t3/src/x.ts'));

rule.invalid('rejects the protocol importing the kit', `import { serveRuntime } from '@teamai/runtime-kit/serve';`, (output) => {
  expect(output).toContain('@teamai/runtime-protocol imports only');
}, inWorkspace('packages/runtime-protocol/src/protocol.ts'));

rule.invalid('rejects the protocol importing a tool fact beyond its levels, home and usage', `import { SIGN_INS } from '@teamai/tool-core/sign-in';`, undefined, inWorkspace('packages/runtime-protocol/src/protocol.ts'));

rule.valid('allows the protocol its levels, home, usage and shared', [
  `import { ACCESS_LEVELS } from '@teamai/tool-core/launch';`, `import { getUserHome } from '@teamai/shared/home';`, `import type { TokenUsage } from '@teamai/tool-core/stdout';`, `import { redact } from '@teamai/shared';`,
].join('\n'), inWorkspace('packages/runtime-protocol/src/protocol.ts'));

rule.invalid('rejects the kit importing a tool package', `import { ACCESS_LEVELS } from '@teamai/tool-core/launch';`, (output) => {
  expect(output).toContain('@teamai/runtime-kit imports only @teamai/runtime-protocol and @teamai/shared');
}, inWorkspace('packages/runtime-kit/src/serve.ts'));

rule.valid('allows the kit the protocol and shared', `import { RuntimeRequestSchema } from '@teamai/runtime-protocol';
import { redact } from '@teamai/shared';`, inWorkspace('packages/runtime-kit/src/serve.ts'));

rule.valid("allows a runtime's test harness and its tests the runtime test kit", `import { connectRuntime } from '@teamai/runtime-testing/connect';`, inWorkspace('packages/runtime-t3/src/testing/harness.ts'));

rule.valid('allows a src/ test the runtime test kit', `import { bundleRuntime } from '@teamai/runtime-testing/bundle';`, inWorkspace('src/__tests__/helpers/t3-runtime.ts'));

rule.invalid('rejects production code in a runtime importing the runtime test kit', `import { connectRuntime } from '@teamai/runtime-testing/connect';`, (output) => {
  expect(output).toContain('@teamai/runtime-testing is test-only');
}, inWorkspace('packages/runtime-t3/src/runtime.ts'));

rule.invalid('rejects src/ production code importing the runtime test kit', `import { bundleRuntime } from '@teamai/runtime-testing/bundle';`, (output) => {
  expect(output).toContain('src/ never imports a runtime package');
  expect(output).toContain('@teamai/runtime-testing is test-only');
}, inWorkspace('src/workflow/engine.ts'));

rule.invalid('rejects src/ test support importing the kit', `import { opLedger } from '@teamai/runtime-kit/ledger';`, (output) => {
  expect(output).toContain('src/ never imports a runtime package');
}, inWorkspace('src/__tests__/engine.test.ts'));

const launchLibrary = { 'packages/tool-launch/package.json': JSON.stringify({ name: '@teamai/tool-launch', private: true }), 'packages/tool-launch/src/run-step-launch.ts': 'export const run = 1;' };

rule.valid('reads the launch library as no tool family, so src/ imports it', `import { run } from '@teamai/tool-launch/run-step-launch';
export const launched = run;`, inWorkspace('src/workflow/steps/prompt.ts', launchLibrary));

rule.valid('allows the launch library the tool contract', `import type { StepLaunch } from '@teamai/tool-core/launch';
export type Step = StepLaunch;`, inWorkspace('packages/tool-launch/src/step.ts', launchLibrary));

rule.invalid('rejects the launch library starting a process', `import { spawn } from 'node:child_process';
export const start = () => spawn('claude');`, (output) => {
  expect(output).toContain('@teamai/tool-launch starts no process');
  expect(output).toContain('packages/tool-launch/src/step.ts -> node:child_process');
}, inWorkspace('packages/tool-launch/src/step.ts', launchLibrary));

rule.invalid('rejects the launch library starting a process through the shared exec helpers', `import { spawnCommand } from '@teamai/shared/exec';
export const run = () => spawnCommand('x', [], {});`, (output) => {
  expect(output).toContain('packages/tool-launch/src/step.ts -> @teamai/shared/exec');
}, inWorkspace('packages/tool-launch/src/step.ts', launchLibrary));

rule.valid('allows the launch library\'s tests to start a process', `import { execFileSync } from 'node:child_process';
export const fifo = () => execFileSync('mkfifo', ['x']);`, inWorkspace('packages/tool-launch/src/step.test.ts', launchLibrary));

rule.invalid('rejects the launch library importing a runtime package', `import { serveRuntime } from '@teamai/runtime-kit/serve';
export const serve = serveRuntime;`, (output) => {
  expect(output).toContain('@teamai/tool-launch imports no runtime package');
}, inWorkspace('packages/tool-launch/src/step.ts', launchLibrary));

rule.invalid('rejects the launch library importing src/', `import { locate } from '../../../src/locate.js';
export const found = locate;`, (output) => {
  expect(output).toContain('packages/tool-launch/src/step.ts -> src/locate.js');
}, inWorkspace('packages/tool-launch/src/step.ts', launchLibrary));

rule.invalid('covers a module added in a new folder of the launch library, with no rule edit', `import { runtime } from '@teamai/runtime-sandbox';
import { fork } from 'child_process';
export const start = [runtime, fork];`, (output) => {
  expect(output).toContain('packages/tool-launch/src/hosts/start.ts -> @teamai/runtime-sandbox');
  expect(output).toContain('packages/tool-launch/src/hosts/start.ts -> child_process');
}, inWorkspace('packages/tool-launch/src/hosts/start.ts', launchLibrary));

rule.invalid('rejects a package reaching src/ through an import-equals require', `import locate = require('../../../src/locate.js');
export const found = locate;`, (output) => {
  expect(output).toContain('packages/tool-core/src/sessions.ts -> src/locate.js');
}, inWorkspace('packages/tool-core/src/sessions.ts'));

rule.invalid('rejects src/ reaching a runtime package through an import-equals require', `import runtime = require('@teamai/runtime-sandbox');
export const found = runtime;`, (output) => {
  expect(output).toContain('src/workflow/engine.ts -> @teamai/runtime-sandbox');
}, inWorkspace('src/workflow/engine.ts'));

rule.valid('reads a namespace alias as no import', `namespace Paths { export const root = '/'; }
import root = Paths.root;
export const found = root;`, inWorkspace('packages/tool-core/src/sessions.ts'));

rule.invalid('rejects the launch library reading the tool registry, which its caller resolves', `import { BUILT_IN_TOOLS } from '@teamai/tool-definitions';
export const tools = BUILT_IN_TOOLS;`, (output) => {
  expect(output).toContain('@teamai/tool-launch runs the tool its caller resolved');
  expect(output).toContain('packages/tool-launch/src/hosts/pick.ts -> @teamai/tool-definitions');
}, inWorkspace('packages/tool-launch/src/hosts/pick.ts', launchLibrary));

rule.valid('allows the launch library\'s tests and test support the tool registry', `import { BUILT_IN_TOOLS } from '@teamai/tool-definitions';
export const tools = BUILT_IN_TOOLS;`, inWorkspace('packages/tool-launch/src/testing/launcher-conformance.ts', launchLibrary));
