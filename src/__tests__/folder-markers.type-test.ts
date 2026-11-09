// Compile-time checks for src/folder-markers.ts, run by `npm run typecheck`. A folder type this release reads has no
// "cannot read yet" line, and only a type it skips can be a skipped folder.
import { FOLDER_MARKERS, type SkippedFolder } from '../folder-markers.js';

// A type that is read carries no skip line.
// @ts-expect-error workflows are read, so they have no skip line
void FOLDER_MARKERS.workflows.skipped;

// A type that is skipped carries one.
void FOLDER_MARKERS.agents.skipped;

// @ts-expect-error a rule folder is read, so it is never a skipped folder
export const ruleFolder: SkippedFolder = { type: 'rules', path: 'rules/api-style/' };

export const agentFolder: SkippedFolder = { type: 'agents', path: 'agents/reviewer/' };
