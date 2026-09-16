import { afterEach, describe, expect, it, vi } from 'vitest';

const originalArgv = process.argv;

afterEach(() => {
  process.argv = originalArgv;
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

  await expect(import('../index.js')).rejects.toThrow('process.exit(0)');
  return output;
}

describe('import command registration', () => {
  it('lists JSON output for cache status and GC', async () => {
    const output = await readImportHelp();
    expect(output).toContain('--json');
    expect(output).toContain('Output cache status or GC result as JSON');
  });
});
