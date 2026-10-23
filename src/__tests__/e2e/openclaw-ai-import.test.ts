import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));

it.runIf(process.platform !== 'win32')('imports code with OpenClaw as the only available AI CLI', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-openclaw-ai-'));
  try {
    const home = path.join(root, 'home');
    const bin = path.join(root, 'bin');
    const source = path.join(root, 'source');
    const output = path.join(root, 'output');
    const receipt = path.join(root, 'calls.jsonl');
    for (const dir of [home, bin, path.join(source, 'src')]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(source, 'src', 'greet.ts'), Array.from({ length: 6 }, (_, i) => `export function greet${i}(name: string): string { return 'Hello ' + name; }`).join('\n'));
    const openclaw = path.join(bin, 'openclaw');
    fs.writeFileSync(openclaw, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] !== 'agent' || args[1] !== '--session-id' || args[3] !== '--message' || args.length !== 5) process.exit(2);
fs.appendFileSync(process.env.TEST_OPENCLAW_RECEIPT, JSON.stringify(args) + '\\n');
console.log(JSON.stringify({ domain: 'openclaw-proof', description: 'Fixture import', keywords: ['openclaw-proof'], responsibilities: ['Greet users'], layer: 'service', summary: 'Greeter module' }));
`, { mode: 0o755 });
    const resolver = `#!${process.execPath}
const args = process.argv.slice(2);
if (args.join(' ') === '-lc command -v openclaw' || args.join(' ') === 'openclaw') console.log(${JSON.stringify(openclaw)});
else process.exit(1);
`;
    for (const name of ['bash', 'zsh', 'which']) fs.writeFileSync(path.join(bin, name), resolver, { mode: 0o755 });
    const run = spawnSync(process.execPath, [cli, 'import', '--dir', source, '--output', output, '--all'], {
      cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home, PATH: `${bin}:/usr/bin:/bin`, TEST_OPENCLAW_RECEIPT: receipt, FORCE_COLOR: '0' },
      encoding: 'utf8', timeout: 30_000,
    });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    const calls: string[][] = fs.readFileSync(receipt, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(calls.length).toBeGreaterThan(0);
    expect(new Set(calls.map(args => args[2])).size).toBe(calls.length);
    const domains = path.join(output, 'teamwiki', 'evidence', 'code', 'source', '_domains.json');
    expect(fs.existsSync(domains), run.stdout + run.stderr).toBe(true);
    expect(fs.readFileSync(domains, 'utf8')).toContain('openclaw-proof');

    // OpenClaw can report provider failures on stdout rather than stderr.
    fs.rmSync(path.join(output, 'teamwiki/evidence/code/source/docs/architecture.md'));
    fs.writeFileSync(openclaw, `#!${process.execPath}\nconsole.log('OpenClaw provider rejected the request');\nprocess.exit(1);\n`, { mode: 0o755 });
    const failed = spawnSync(process.execPath, [cli, 'codebase', '--deep-enrich', '--project', 'source', '--output', output], {
      cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home, PATH: `${bin}:/usr/bin:/bin`, FORCE_COLOR: '0' },
      encoding: 'utf8', timeout: 30_000,
    });
    expect(failed.stdout + failed.stderr).toContain('AI call failed: OpenClaw provider rejected the request');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
