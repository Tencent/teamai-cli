import { toolHomeVariableNames } from '../../tool-home.js';

/** Every variable that moves a tool's root, from the one list teamai reads them from (`toolHomeVariableNames`). */
export function toolRootVariables(): string[] {
  return [...toolHomeVariableNames()];
}
