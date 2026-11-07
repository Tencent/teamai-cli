import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { executableOf, LAUNCH_ORDER } from '../tool-launch/tools.js';

const RULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../oxlint-plugin-teamai/rules/launch-through-workflows.js');

describe('the executables teamai/launch-through-workflows refuses to run outside a driver', () => {
  it('are the executable of every tool teamai launches', async () => {
    const { TOOL_EXECUTABLES } = z.object({ TOOL_EXECUTABLES: z.set(z.string()) }).parse(await import(pathToFileURL(RULE).href));

    expect([...TOOL_EXECUTABLES].sort()).toEqual([...new Set(LAUNCH_ORDER.map(executableOf))].sort());
  });
});
