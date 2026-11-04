import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reconcileHooks } from '../hooks.js';
import { parseJsonAs, type JsonSyntax } from '../utils/json.js';

/**
 * A tool that reads its hook file with comments keeps working when the member
 * comments it: teamai reads the file as the tool does, adds its hooks, and
 * leaves the member's comments where they were.
 */
describe('reconcileHooks with a commented hook file', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-hooks-commented-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const cases: ReadonlyArray<{ tool: string; syntax: JsonSyntax; text: string }> = [
    { tool: 'cursor', syntax: 'json-comments', text: '{\n  // the member\'s note\n  "version": 1,\n  "hooks": {}\n}\n' },
    { tool: 'codebuddy', syntax: 'jsonc', text: '{\n  // the member\'s note\n  "model": "x",\n  "hooks": {},\n}\n' },
    { tool: 'qoder', syntax: 'json-comments', text: '{\n  /* the member\'s note */\n  "theme": "dark"\n}\n' },
  ];

  it.each(cases)('adds $tool\'s hooks and keeps the comment', async ({ tool, syntax, text }) => {
    const file = path.join(dir, `${tool}.json`);
    fs.writeFileSync(file, text);

    await reconcileHooks(file, tool, []);

    const written = fs.readFileSync(file, 'utf8');
    expect(written).toContain('the member\'s note');
    expect(JSON.stringify(parseJsonAs(written, syntax))).toContain(`hook-dispatch session-start --tool ${tool}`);
  });

  it('edits a commented file at its link\'s target and keeps its mode', async () => {
    const real = path.join(dir, 'dotfiles-settings.json');
    const link = path.join(dir, 'settings.json');
    fs.writeFileSync(real, '{\n  // note\n  "model": "x",\n}\n', { mode: 0o640 });
    fs.chmodSync(real, 0o640);
    const mode = fs.statSync(real).mode & 0o777;
    fs.symlinkSync(real, link);

    await reconcileHooks(link, 'codebuddy', []);

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.statSync(real).mode & 0o777).toBe(mode);
    expect(fs.readFileSync(real, 'utf8')).toContain('// note');
  });

  it('leaves a Cursor hooks.json with a trailing comma as it is: Cursor refuses one', async () => {
    const file = path.join(dir, 'hooks.json');
    const text = '{\n  // note\n  "version": 1,\n  "hooks": {},\n}\n';
    fs.writeFileSync(file, text);

    await expect(reconcileHooks(file, 'cursor', [])).rejects.toThrow(`${file} does not parse`);
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
  });

  it('leaves a commented Claude settings.json as it is: Claude Code 2.1.316 refuses it', async () => {
    const file = path.join(dir, 'settings.json');
    const text = '{\n  // note\n  "hooks": {}\n}\n';
    fs.writeFileSync(file, text);

    await expect(reconcileHooks(file, 'claude', [])).rejects.toThrow(`${file} does not parse`);
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
  });
});
