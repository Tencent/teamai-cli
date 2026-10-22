import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';
import { WINDOWS_TESTS } from './src/__tests__/helpers/windows-tests.js';

export default defineConfig({
  ...base,
  test: { ...base.test, include: [...WINDOWS_TESTS], exclude: [] },
});
