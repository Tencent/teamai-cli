/**
 * Conformance scenarios for benchmark trials at the protocol level: which driver is leased a trial, once the run's plan
 * step printed them. What a prepared trial does on disk, and how a run whose trials no driver took ends, are the
 * driver-contract e2e's.
 */
import { DRIVER_PROFILES, type BenchmarkScenario, type BenchmarkSuiteFiles } from '../workflow/conformance-interpreter.js';
import type { DriverCan } from '../workflow/requirements.js';

/** One check task `fix`, one repetition, and two arms: `claude` from the defaults, and `codex`. */
const TWO_ARMS: BenchmarkSuiteFiles = {
  name: 'fix',
  suite: `schemaVersion: v1alpha1
name: fix
description: Fix the answer with two tools.
repo: https://github.com/fixture/app.git
defaults:
  tool: claude
arms:
  - name: claude
  - name: codex
    tool: codex
repetitions: 1
timeout: 10m
`,
  tasks: {
    fix: `schemaVersion: v1alpha1
title: Fix the answer
prompt: Make node test.js pass.
startingCommit: '{{startingCommit}}'
check:
  run: node test.js
  protect: [test.js]
`,
  },
};

/** An external driver that provides the clones a benchmark's trials open, and their env. */
const CLONES: DriverCan = { workspace: [...DRIVER_PROFILES.external.can.workspace, 'clone'], env: true, tools: ['claude'] };
/** The baseline of task `fix`: the first step of the run, which every driver must be able to take before any trial runs. */
const BASELINE = 'trials.baselines.fix';

export const benchmarkConformanceScenarios: BenchmarkScenario[] = [
  {
    name: 'a driver that does not declare a sandbox is held, not leased, the task baseline that runs before any trial',
    benchmark: TWO_ARMS,
    operations: [{ kind: 'next', saveAs: 'held', as: 'external', prepare: true, can: CLONES,
      expect: { data: { wait: { held: [{ step: BASELINE, missing: ['isolation'] }] } } } }],
  },
  {
    name: 'a driver that provides clones but does not ask next --prepare is held, not leased, the task baseline that runs before any trial',
    benchmark: TWO_ARMS,
    operations: [{ kind: 'next', saveAs: 'held', as: 'external', can: { ...CLONES, isolation: 'sandbox' },
      expect: { data: { wait: { held: [{ step: BASELINE, missing: ['prepare'] }] } } } }],
  },
];
