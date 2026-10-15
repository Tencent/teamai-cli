/**
 * `teamai script run <event>` — rerun a script declared in teamai.yaml.
 * Init and pull also run these. This command is how a member runs one again,
 * or runs `postInit` after a non-interactive init skipped it.
 */

import { detectProjectConfig, loadLocalConfig, loadTeamConfig } from './config.js';
import {
  isTeamScriptEvent, runTeamScript, syncMcpAfterPostInit, TEAM_SCRIPT_EVENTS, teamScriptPrompts,
} from './team-scripts.js';
import { log } from './utils/logger.js';
import { isInteractive } from './utils/prompt.js';

export async function scriptRun(eventName: string): Promise<void> {
  if (!isTeamScriptEvent(eventName)) {
    log.error(`Unknown script "${eventName}". Expected one of: ${TEAM_SCRIPT_EVENTS.join(', ')}.`);
    process.exitCode = 1;
    return;
  }

  const local = (await detectProjectConfig(process.cwd())) ?? (await loadLocalConfig());
  if (!local) {
    log.error('No teamai config here. Run `teamai init` first.');
    process.exitCode = 1;
    return;
  }

  const team = await loadTeamConfig(local.repo.localPath);
  const declared = team?.scripts?.[eventName]?.path;
  if (!declared) {
    log.error(`This team does not declare scripts.${eventName}.`);
    process.exitCode = 1;
    return;
  }

  if (teamScriptPrompts(eventName) && !isInteractive()) {
    log.error(`scripts.${eventName} reads from the terminal. Run \`teamai script run ${eventName}\` in a terminal.`);
    process.exitCode = 1;
    return;
  }

  const result = await runTeamScript(local, eventName, {
    interactive: teamScriptPrompts(eventName),
    announce: false,
    inherit: true,
  });
  if (result.status !== 'ran') {
    log.error(
      result.status === 'absent'
        ? `scripts.${eventName} was not found: ${declared}`
        : `scripts.${eventName} was not run because its path leaves the team repo.`,
    );
    process.exitCode = 1;
    return;
  }

  if (eventName === 'postInit') await syncMcpAfterPostInit(local);
  if (result.code === 0) return;
  if (result.code === null) {
    log.warn(
      teamScriptPrompts(eventName)
        ? `scripts.${eventName} did not run.`
        : `scripts.${eventName} is still running. This command stopped waiting.`,
    );
    process.exitCode = 1;
    return;
  }
  log.warn(`scripts.${eventName} exited ${result.code}.`);
  process.exitCode = result.code;
}
