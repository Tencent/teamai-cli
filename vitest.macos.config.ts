import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';
import { MACOS_TESTS } from './src/__tests__/helpers/macos-tests.js';

export default defineConfig({
  ...base,
  test: { ...base.test, include: [...MACOS_TESTS], exclude: [] },
});
