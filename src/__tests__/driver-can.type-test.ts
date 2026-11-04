/** Checked by `tsc` only: Vitest runs `*.test.ts`. */
import type { DriverCan } from '../workflow/requirements.js';

/**
 * A driver that sets every capability, as the local driver does, decides which tools it launches, whether it ends a
 * turn at its limits, whether it runs a prompt unattended, whether it runs a step with a role, and which tools it runs confined.
 */
export const decided: Required<DriverCan> = {
  hitl: false, workspace: [], network: false, isolation: 'none', env: true, tokens: true, max_turns: true, setup: true, tools: [], end_turn: true, unattended: false, role: true, confined: [],
};
// @ts-expect-error a driver that sets every capability cannot leave out whether it runs a prompt unattended
export const unsure: Required<DriverCan> = {
  hitl: false, workspace: [], network: false, isolation: 'none', env: true, tokens: true, max_turns: true, setup: true, tools: [], end_turn: true, role: true, confined: [],
};
// @ts-expect-error a driver that sets every capability cannot leave out whether it ends a turn at its limits
export const undecided: Required<DriverCan> = {
  hitl: false, workspace: [], network: false, isolation: 'none', env: true, tokens: true, max_turns: true, setup: true, tools: [], unattended: false, role: true, confined: [],
};
// @ts-expect-error a driver that sets every capability cannot leave out which tools it launches a step that names one on
export const toolless: Required<DriverCan> = {
  hitl: false, workspace: [], network: false, isolation: 'none', env: true, tokens: true, max_turns: true, setup: true, end_turn: true, unattended: false, role: true, confined: [],
};
// @ts-expect-error a driver that sets every capability cannot leave out whether it runs a step with a role
export const roleless: Required<DriverCan> = {
  hitl: false, workspace: [], network: false, isolation: 'none', env: true, tokens: true, max_turns: true, setup: true, tools: [], end_turn: true, unattended: false, confined: [],
};
// @ts-expect-error a driver that sets every capability cannot leave out which tools it runs a prompt confined on
export const unconfined: Required<DriverCan> = {
  hitl: false, workspace: [], network: false, isolation: 'none', env: true, tokens: true, max_turns: true, setup: true, tools: [], end_turn: true, unattended: false, role: true,
};
