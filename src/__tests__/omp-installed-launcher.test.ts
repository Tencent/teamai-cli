import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { buildOmpExtensionSource } from '../omp-hooks.js';

it('executes OMP lifecycle and context callbacks when teamai is absent from PATH', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-omp-launcher-'));
  try {
    const cli = path.join(root, 'installed cli.js');
    const calls = path.join(root, 'calls.jsonl');
    fs.writeFileSync(cli, `const fs = require('node:fs'); let text = ''; process.stdin.on('data', c => text += c); process.stdin.on('end', () => { fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({args:process.argv.slice(2),payload:JSON.parse(text)})+'\\n'); console.log(JSON.stringify({hookSpecificOutput:{additionalContext:'INSTALLED-CONTEXT'}})); });`);
    // Installation captures the CLI process's entry, which may contain spaces.
    const previous = process.argv[1];
    let source: string;
    try { process.argv[1] = cli; source = buildOmpExtensionSource(); }
    finally { process.argv[1] = previous; }
    const extension = path.join(root, 'extension.mjs');
    fs.writeFileSync(extension, source.replace('import { $ } from "bun";', `import {spawnSync} from 'node:child_process';
const $ = (_strings, launcher, args, response) => {
 const run = response.text().then(input => {
  const result = spawnSync(launcher[0], [...launcher.slice(1), ...args], {input, encoding:'utf8', env:process.env});
  return result.stdout ?? '';
 });
 const output = Object.assign(run, {text:async()=>run});
 return {quiet:()=>({nothrow:()=>output})};
};`));
    const host = `import install from ${JSON.stringify(extension)}; const handlers={}; install({on:(event,fn)=>handlers[event]=fn}); const ctx={cwd:${JSON.stringify(root)},sessionManager:{getSessionId:()=> 'fixture'}}; await handlers.session_start({},ctx); const result=await handlers.before_agent_start({prompt:'hi',systemPrompt:['original']},ctx); await handlers.session_stop({},ctx); console.log(JSON.stringify(result));`;
    const out = execFileSync(process.execPath, ['--input-type=module', '--eval', host], { env: { ...process.env, PATH: '' }, encoding: 'utf8' });
    expect(out).toContain('INSTALLED-CONTEXT');
    expect(fs.readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line).args[1]).sort()).toEqual(['instructions', 'prompt-submit', 'session-start', 'stop']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
