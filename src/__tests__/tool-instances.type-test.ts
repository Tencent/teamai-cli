/** Checked by `tsc` only: Vitest runs `*.test.ts`. */
import type { DeclaredTool, ResolvedToolAdjustment } from '../tool-instances.js';

declare const file: Omit<ResolvedToolAdjustment, 'kind'>;

export const adjustment: DeclaredTool = { ...file, kind: 'adjustment' };

// @ts-expect-error an adjustment of a shipped tool runs that tool's own command
export const commanded: DeclaredTool = { ...file, kind: 'adjustment', command: 'acme-claude' };

// @ts-expect-error and lives in that tool's own home
export const homed: DeclaredTool = { ...file, kind: 'adjustment', home: { dir: '.work-claude' } };

export const instance: DeclaredTool = { ...file, kind: 'instance', command: 'acme-claude', home: { dir: '.acme-claude' } };
