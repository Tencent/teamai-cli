import { afterEach, describe, expect, it, vi } from 'vitest';

const originalArgv = process.argv;

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.resetModules();
});

async function readImportHelp(): Promise<string> {
  let output = '';
  process.argv = ['node', 'teamai', 'import', '--help'];
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

describe('import command registration', () => {
  it('lists JSON output for cache status and GC', async () => {
    const output = await readImportHelp();
    expect(output).toContain('--json');
    expect(output).toContain('Output cache status or GC result as JSON');
  });
});
