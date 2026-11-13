import path from 'node:path';
import { RuntimeMessageSchema, type RuntimeMessage } from '@teamai/runtime-protocol';
import { runtimeStateRoot } from '@teamai/runtime-protocol/state-root';
import { getUserHome } from '@teamai/shared/home';
import { journal } from './journal.js';
import { serve } from './runtime.js';

// teamai-runtime-paseo: teamai spawns it for a driver definition that uses runtime `paseo`, and speaks runtime protocol
// 1 to it over stdio. Its stdout carries only protocol lines; anything for a person goes to stderr.

// When teamai is gone, a line it would have read goes nowhere: a prompt still running keeps going and records its end.
// So does a note on stderr, which the runtime writes for a request it drops.
let stdoutOpen = true;
let stderrOpen = true;

process.stdout.on('error', () => { stdoutOpen = false; });

process.stderr.on('error', () => { stderrOpen = false; });

/** Paseo sets PASEO_AGENT_ID in each agent it runs, so a run started from one names it. */
const startedFrom = process.env['PASEO_AGENT_ID'];

const status = await serve({
  env: process.env,
  // A line teamai could not read is a bug here: it fails where it is written.
  write: (message: RuntimeMessage) => {
    if (stdoutOpen) process.stdout.write(`${JSON.stringify(RuntimeMessageSchema.parse(message))}\n`);
  },
  note: (text: string) => {
    if (stderrOpen) process.stderr.write(`${text}\n`);
  },
  journal: journal(path.join(runtimeStateRoot(getUserHome()), 'paseo')),
  ...(startedFrom && { startedFrom }),
});

process.exit(status);
