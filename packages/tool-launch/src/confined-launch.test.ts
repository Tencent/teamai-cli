import { describe, expect, it } from 'vitest';
import { BUILT_IN_TOOLS } from '@teamai/tool-definitions';
import { confinedArgs, confinedStdin, confinedVariables } from './confined-launch.js';

describe('a confined launch', () => {
  it('passes an OpenCode effort as a variant on OpenCode 1 and on the model on OpenCode 2', () => {
    const model = { name: 'anthropic/claude-sonnet', effort: 'high' };

    expect(confinedArgs({ family: 'opencode', model, opencodeMajor: 1 })).toEqual(['run', '--standalone', '--format', 'json', '--model', 'anthropic/claude-sonnet', '--variant', 'high']);
    expect(confinedArgs({ family: 'opencode', model, opencodeMajor: 2 })).toEqual(['run', '--standalone', '--format', 'json', '--model', 'anthropic/claude-sonnet#high']);
  });

  it('gives Claude, which reads the prompt from its file, only the request on stdin, and every other tool the prompt after it', () => {
    expect(confinedStdin('claude', 'Score it.')).not.toContain('Score it.');
    expect(confinedStdin('codex', 'Score it.').endsWith('\nScore it.')).toBe(true);
  });

  it('keeps the common variables and those the tool\'s confined profile reads', () => {
    const names = confinedVariables(BUILT_IN_TOOLS.codex.launch.codex.confined);

    expect(names).toEqual(expect.arrayContaining(['PATH', 'HOME', 'HTTPS_PROXY', 'CODEX_HOME', 'OPENAI_API_KEY']));
  });
});
