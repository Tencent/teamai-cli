import { PROVIDER_COMMANDS } from './provider-commands.js';

/** The commands this runtime runs on the member's machine: each sandbox provider's that runs here. Loads nothing of the runtime. */
export const HOST_COMMANDS: readonly string[] = Object.values(PROVIDER_COMMANDS).flatMap((command) => (command === undefined ? [] : [command]));
