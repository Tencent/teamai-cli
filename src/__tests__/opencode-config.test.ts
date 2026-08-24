import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
}));

import { reconcileOpencodeInstructions, opencodeRulesGlob } from '../resources/opencode-config.js';

describe('opencodeRulesGlob', () => {
  it('project scope: config at root, rules under .opencode/rules', () => {
    const glob = opencodeRulesGlob('/repo/opencode.json', '/repo/.opencode/rules');
    expect(glob).toBe('.opencode/rules/*.md');
  });

  it('user scope: both under ~/.config/opencode', () => {
    const glob = opencodeRulesGlob('/home/u/.config/opencode/opencode.json', '/home/u/.config/opencode/rules');
    expect(glob).toBe('rules/*.md');
  });
});

describe('reconcileOpencodeInstructions', () => {
  let tmpDir: string;
  let configFile: string;
  const GLOB = '.opencode/rules/*.md';

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-oc-cfg-'));
    configFile = path.join(tmpDir, 'opencode.json');
  });

  afterEach(async () => {
    await fse.remove(tmpDir);
  });

  it('creates opencode.json with just the glob when absent and present=true', async () => {
    const wrote = await reconcileOpencodeInstructions(configFile, GLOB, true);
    expect(wrote).toBe(true);
    expect(await fse.readJson(configFile)).toEqual({ instructions: [GLOB] });
  });

  it('does nothing when absent and present=false', async () => {
    const wrote = await reconcileOpencodeInstructions(configFile, GLOB, false);
    expect(wrote).toBe(false);
    expect(await fse.pathExists(configFile)).toBe(false);
  });

  it('adds the glob to an existing instructions array, preserving other entries and keys', async () => {
    await fse.writeJson(configFile, {
      $schema: 'https://opencode.ai/config.json',
      instructions: ['CONTRIBUTING.md'],
      mcp: { srv: { type: 'local', command: ['x'], enabled: true } },
    });
    const wrote = await reconcileOpencodeInstructions(configFile, GLOB, true);
    expect(wrote).toBe(true);
    const doc = await fse.readJson(configFile);
    expect(doc.instructions).toEqual(['CONTRIBUTING.md', GLOB]);
    expect(doc.$schema).toBe('https://opencode.ai/config.json');
    expect(doc.mcp.srv).toBeDefined();
  });

  it('is idempotent — adding an already-present glob does not write', async () => {
    await fse.writeJson(configFile, { instructions: [GLOB] });
    const wrote = await reconcileOpencodeInstructions(configFile, GLOB, true);
    expect(wrote).toBe(false);
  });

  it('removes only our glob, keeping the user\'s own instructions', async () => {
    await fse.writeJson(configFile, { instructions: ['CONTRIBUTING.md', GLOB] });
    const wrote = await reconcileOpencodeInstructions(configFile, GLOB, false);
    expect(wrote).toBe(true);
    expect((await fse.readJson(configFile)).instructions).toEqual(['CONTRIBUTING.md']);
  });

  it('drops the instructions key entirely when removing the last (all-string) entry', async () => {
    await fse.writeJson(configFile, { instructions: [GLOB], mcp: {} });
    await reconcileOpencodeInstructions(configFile, GLOB, false);
    const doc = await fse.readJson(configFile);
    expect(doc.instructions).toBeUndefined();
    expect(doc.mcp).toBeDefined();
  });

  it('leaves a malformed (non-object) config untouched and returns false', async () => {
    await fse.writeFile(configFile, '["not", "an", "object"]');
    const wrote = await reconcileOpencodeInstructions(configFile, GLOB, true);
    expect(wrote).toBe(false);
    expect(await fse.readFile(configFile, 'utf-8')).toBe('["not", "an", "object"]');
  });

  it('treats an empty file as an empty object and adds the glob', async () => {
    await fse.writeFile(configFile, '');
    const wrote = await reconcileOpencodeInstructions(configFile, GLOB, true);
    expect(wrote).toBe(true);
    expect((await fse.readJson(configFile)).instructions).toEqual([GLOB]);
  });

  it('preserves the position of non-string entries when adding the glob', async () => {
    const objEntry = { path: 'dynamic.md', enabled: true };
    await fse.writeJson(configFile, { instructions: [objEntry, 'user.md'] });
    const wrote = await reconcileOpencodeInstructions(configFile, GLOB, true);
    expect(wrote).toBe(true);
    // The object entry must NOT be relocated to the end — only our glob is appended.
    expect((await fse.readJson(configFile)).instructions).toEqual([objEntry, 'user.md', GLOB]);
  });

  it('preserves the position of non-string entries when removing the glob', async () => {
    const objEntry = { path: 'dynamic.md', enabled: true };
    await fse.writeJson(configFile, { instructions: [objEntry, 'user.md', GLOB] });
    const wrote = await reconcileOpencodeInstructions(configFile, GLOB, false);
    expect(wrote).toBe(true);
    expect((await fse.readJson(configFile)).instructions).toEqual([objEntry, 'user.md']);
  });

  it('keeps a non-string entry even when it is the only survivor after removing the glob', async () => {
    const objEntry = { path: 'dynamic.md' };
    await fse.writeJson(configFile, { instructions: [objEntry, GLOB] });
    const wrote = await reconcileOpencodeInstructions(configFile, GLOB, false);
    expect(wrote).toBe(true);
    expect((await fse.readJson(configFile)).instructions).toEqual([objEntry]);
  });
});
