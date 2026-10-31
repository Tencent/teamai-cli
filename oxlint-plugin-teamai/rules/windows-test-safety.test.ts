import { describe, expect } from 'vitest';

import { ruleHarness } from '../test/harness.ts';

const rule = ruleHarness('teamai/windows-test-safety', { filename: 'src/__tests__/windows-test-list.test.ts' });

const valid = `
import { execFileSync } from 'node:child_process';
export function check(): string {
  return execFileSync('node', ['--version'], { encoding: 'utf8' });
}
`;

describe('teamai/windows-test-safety', () => {
  rule.valid('allows Windows-safe subprocesses in the allow-list', valid);
  rule.valid('allows a bash rendering with a Windows counterpart', `
const commandWindows = 'powershell -Command run';
expect(rendered).toBe('bash -lc run');
`);
  rule.invalid('rejects POSIX shebang fixtures', `
const fixture = '#!/usr/bin/env node';
`, (output) => expect(output).toContain('POSIX shebang'));
  rule.invalid('requires bash renderings to be platform-pinned', `
expect(rendered).toBe('bash -lc run');
`, (output) => expect(output).toContain('platform-pin'));
  rule.invalid('rejects sh renderings', `
expect(rendered).toBe('sh -c run');
`, (output) => expect(output).toContain('sh -c rendering'));
  rule.invalid('rejects bash subprocesses', `
import { spawnSync } from 'node:child_process';
spawnSync('bash', ['-lc', 'echo ok']);
`, (output) => expect(output).toContain('POSIX shell bash'));
  rule.invalid('rejects exec shell commands', `
import { execSync } from 'node:child_process';
execSync('bash -lc "echo ok"');
`, (output) => expect(output).toContain('POSIX shell command bash -lc'));
  rule.invalid('rejects chmod', `
import { chmod } from 'node:fs/promises';
await chmod('fixture.sh', 0o755);
`, (output) => expect(output).toContain('chmod()'));
  rule.valid('does not inspect non-Windows test files', `
const fixture = '#!/usr/bin/env node';
import { spawnSync } from 'node:child_process';
spawnSync('bash', ['-lc', 'echo ok']);
`, { filename: 'src/__tests__/linux-only.test.ts' });
});