import { expect } from 'vitest';

import { ruleHarness } from '../test/harness.ts';

const rule = ruleHarness('teamai/process-reads', { filename: 'src/tree.ts' });

const MESSAGE = 'Linux answers from /proc where macOS runs ps';

rule.invalid('rejects a read of a process\'s /proc file that is never told', `import fs from 'node:fs';
export const parentOf = (pid: number) => fs.readFileSync(\`/proc/\${pid}/stat\`, 'utf8');`, (output) => {
  expect(output).toContain(MESSAGE);
});

rule.invalid('rejects a fixed /proc path in a package', `import fs from 'node:fs';
export const own = () => fs.readFileSync('/proc/self/stat', 'utf8');`, (output) => {
  expect(output).toContain(MESSAGE);
}, { filename: 'packages/runtime-x/src/own.ts' });

rule.invalid('rejects the process listing, a /proc path joined or added up, each untold', `import fs from 'node:fs';
import path from 'node:path';
export const all = (pid: number) => [fs.readdirSync('/proc'), fs.readFileSync(path.join('/proc', String(pid), 'stat')), fs.readFileSync('/proc' + '/' + pid + '/comm')];`, (output) => {
  expect(output.match(/Linux answers from \/proc where macOS runs ps/g)).toHaveLength(3);
});

rule.invalid('rejects /proc first held in a variable, then listed, joined or put at the head of a template', `import fs from 'node:fs';
import path from 'node:path';
export const all = (pid: number) => [fs.readdirSync(PROC), fs.readFileSync(path.join(PROC, String(pid), 'stat')), fs.readFileSync(\`\${PROC}/\${pid}/stat\`)];
const PROC = '/proc';
export const mounts = ['--proc', PROC, \`--bind=\${PROC}\`];`, (output) => {
  expect(output.match(/Linux answers from \/proc where macOS runs ps/g)).toHaveLength(3);
});

rule.invalid('rejects a /proc read in a module that only imports the way to tell it', `import fs from 'node:fs';
import { tellProcessRead } from '@teamai/shared/process-group';
export const parentOf = (pid: number) => fs.readFileSync(\`/proc/\${pid}/stat\`, 'utf8');
export { tellProcessRead };`, (output) => {
  expect(output).toContain(MESSAGE);
});

rule.valid('allows a /proc read in a module that tells its reads', `import fs from 'node:fs';
import { tellProcessRead } from '@teamai/shared/process-group';
export const parentOf = (pid: number) => {
  tellProcessRead({ ps: ['-o', 'ppid=', '-p', String(pid)], spawned: false });
  return fs.readFileSync(\`/proc/\${pid}/stat\`, 'utf8');
};`);

rule.valid('allows /proc as a mount a sandbox gives, which reads no process', `export const args = ['--proc', '/proc', '--dev', '/dev'];`, { filename: 'packages/runtime-sandbox/src/providers/bwrap.ts' });

rule.valid('allows a test to read /proc', `import fs from 'node:fs';
export const own = () => fs.readFileSync('/proc/self/stat', 'utf8');`, { filename: 'src/__tests__/tree.test.ts' });
