import { describe, it, expect } from 'vitest';
import { invokesRecall } from '../recall-adoption.js';

describe('invokesRecall npx value options', () => {
  it.each([
    ['teamai recall "q"', true],
    ['teamai -v recall "q"', true],
    ['npx -y teamai-cli@0.22.0 --verbose recall "q"', true],
    ['npx -p teamai-cli teamai recall "q"', true],
    ['npx --package teamai-cli@0.22.0 teamai recall "q"', true],
    ['npx -p teamai-cli teamai --verbose recall "q"', true],
    ['codex exec "run teamai recall q"', false],
  ])('%s -> %s', (cmd, want) => {
    expect(invokesRecall(cmd)).toBe(want);
  });
});
