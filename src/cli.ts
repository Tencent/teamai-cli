import { FLEET_GUARDIAN_ENV } from './workflow/fleet/guardian-mode.js';

// The CLI bundle (dist/cli.js), which the executable (bin.ts) loads. A fleet step's guardian loads it too, with
// FLEET_GUARDIAN_ENV set to what it stops: that mode runs the guardian's code and never loads the command table, so it
// adds no command. Each side is imported lazily, so the bundle evaluates only the one it runs.
const guardian = process.env[FLEET_GUARDIAN_ENV];

if (guardian === undefined) {
  await import('./index.js');
} else {
  // A process the guardian starts, such as a step runtime's, runs teamai as itself.
  delete process.env[FLEET_GUARDIAN_ENV];
  const { runFleetGuardian } = await import('./workflow/fleet/guardian-stop.js');
  await runFleetGuardian(guardian);
}
