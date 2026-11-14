import { homeVariables, isToolId, TOOLS } from '../../tools.js';
import { RELOCATABLE_TOOLS } from '../../types.js';

/** Every variable that moves a tool's root, from both places teamai reads one. */
export function toolRootVariables(): string[] {
  return [
    ...Object.values(RELOCATABLE_TOOLS).map(({ envVar }) => envVar),
    ...Object.keys(TOOLS).filter(isToolId).flatMap(homeVariables),
  ];
}
