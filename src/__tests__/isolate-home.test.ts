import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { TEAMAI_SOURCES_DIR } from '../types.js';
import { getUserHome } from '@teamai/shared/home';

// Guards helpers/isolate-home.ts (#924): a unit test that reaches the real home
// shares ~/.teamai, and its sync lock, with every teamai session on the machine.
describe('unit test home isolation', () => {
  it('runs each test file with a temp home, not the real one', () => {
    expect(getUserHome()).not.toBe(os.userInfo().homedir);
  });

  it('isolates the home before any module builds a path from it', () => {
    expect(TEAMAI_SOURCES_DIR).toBe(path.join(getUserHome(), '.teamai', 'sources'));
  });
});
