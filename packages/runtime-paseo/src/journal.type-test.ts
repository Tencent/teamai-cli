/** Checked by `tsc` only: Vitest runs `*.test.ts`. */
import { RUN_DIR_ENV, WORKFLOW_DIR_ENV } from '@teamai/runtime-protocol';
import type { AgentCreate } from './journal.js';

/** Paseo keeps an agent's env in plain text, so the runtime gives it the run directory and the workflow folder. */
export const folders: AgentCreate['env'] = { [RUN_DIR_ENV]: '/run', [WORKFLOW_DIR_ENV]: '/folder' };

// @ts-expect-error nothing else of a step's env reaches an agent this runtime creates, which could carry a secret
export const leaked: AgentCreate['env'] = { [RUN_DIR_ENV]: '/run', DEPLOY_TOKEN: 'secret' };
