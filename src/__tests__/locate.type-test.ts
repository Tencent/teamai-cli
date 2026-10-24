/** Checked by `tsc` only: Vitest runs `*.test.ts`. */
import { writable, type Location, type PlaceOf } from '../locate.js';

declare const mcp: Location<'mcp'>;

/** A writer gets its resource's place kind without narrowing. */
export const entry: PlaceOf['mcp'] | null = writable(mcp);

// @ts-expect-error an MCP location writes a map in a file, never a directory
export const dir: PlaceOf['skills'] | null = writable(mcp);

// @ts-expect-error teamai adds no agents at run time
export const runTimeAgents: Location<'agents'>['channel'] = 'run-time';
