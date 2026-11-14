import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toolHomeVariableNames } from '../tool-home.js';
import { homeVariableOf, LAUNCH_ORDER } from '../tool-launch/tools.js';

const RULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../oxlint-plugin-teamai/rules/tool-home-env.js');

describe('the variables teamai/tool-home-env refuses to set outside toolCommandEnv', () => {
  it('are every variable that moves a shipped tool\'s home, the one a launch starts it with included', async () => {
    const { HOME_VARIABLES } = z.object({ HOME_VARIABLES: z.set(z.string()) }).parse(await import(pathToFileURL(RULE).href));
    const shipped = toolHomeVariableNames();

    expect([...HOME_VARIABLES].sort()).toEqual([...shipped].sort());
    expect(LAUNCH_ORDER.flatMap((tool) => homeVariableOf(tool) ?? []).filter((variable) => !shipped.has(variable))).toEqual([]);
  });
});
