import { afterEach, describe, expect, it, vi } from 'vitest';

const originalArgv = process.argv;

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.resetModules();
});

async function readCodebaseHelp(): Promise<string> {
  let output = '';
  process.argv = ['node', 'teamai', 'codebase', '--help'];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
    throw new Error(`process.exit(${code})`);
  }) as never);

  // The help text is on stdout by now. The entry reports the throw from the
  // mocked exit as an error and resolves instead of rejecting (#1270).
  await import('../index.js');
  return output;
}

describe('codebase command registration', () => {
  it('lists the public reconcile option', async () => {
    const output = await readCodebaseHelp();
    expect(output).toContain('--reconcile');
  });

  it('lists the public deep-enrich option', async () => {
    const output = await readCodebaseHelp();
    expect(output).toContain('--deep-enrich');
  });

  it('no longer offers --extract: teamai import extracts code knowledge', async () => {
    const output = await readCodebaseHelp();
    expect(output).not.toContain('--extract');
  });
});
