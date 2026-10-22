import { toolHome } from './tool-home.js';

/**
 * Hermes's home on this machine (`toolHome`): the recorded one, else as Hermes
 * resolves it (`TOOLS.hermes.home`): `HERMES_HOME`, else
 * `%LOCALAPPDATA%\hermes` on Windows, else `~/.hermes`.
 */
export function getHermesHome(): string {
  return toolHome('hermes');
}
