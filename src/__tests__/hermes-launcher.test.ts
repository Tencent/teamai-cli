import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import * as builtinHooks from '../builtin-hooks.js';
import { injectHermesHooks, getReportScriptPath, buildInstructionsPlugin } from '../hermes-hooks.js';

// Runtime probes need a POSIX shell and Python. They run in the normal Linux/macOS
// suite; hermes-hooks.test.ts remains in the Windows-safe ownership/config suite.
let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-hermes-launcher-'));
  vi.stubEnv('HOME', tmpDir);
  vi.stubEnv('HERMES_HOME', tmpDir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe.runIf(process.platform !== 'win32')('Hermes installed launcher runtime', () => {
  it.each(['status', 'instructions'] as const)('runs the %s entry without teamai on PATH', async (kind) => {
    const entry = path.join(tmpDir, "CLI with spaces and 'quotes.mjs");
    const observed = path.join(tmpDir, 'observed.json');
    fs.writeFileSync(entry, `import fs from 'node:fs';
      fs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify(process.argv.slice(2)));
      console.log(JSON.stringify({hookSpecificOutput:{additionalContext:'HERMES-CONTEXT'}}));`);
    const resolver = vi.spyOn(builtinHooks, 'resolveCliEntry').mockReturnValue(entry);
    try {
      if (kind === 'status') {
        await injectHermesHooks();
        execFileSync('/bin/bash', [getReportScriptPath()], { env: { ...process.env, PATH: '/usr/bin:/bin' } });
      } else {
        const plugin = path.join(tmpDir, 'plugin.py');
        fs.writeFileSync(plugin, buildInstructionsPlugin().init);
        const result = execFileSync('/usr/bin/python3', ['-c', `import runpy; p = runpy.run_path(${JSON.stringify(plugin)}); print(p['_instructions']({'cwd': ${JSON.stringify(tmpDir)}}))`], {
          env: { ...process.env, PATH: '/usr/bin:/bin' }, encoding: 'utf8',
        });
        expect(result.trim()).toBe('HERMES-CONTEXT');
      }
      expect(JSON.parse(fs.readFileSync(observed, 'utf8'))).toEqual(['hook-dispatch', kind === 'status' ? 'session-start' : 'instructions', '--tool', 'hermes']);
    } finally {
      resolver.mockRestore();
    }
  });

});
