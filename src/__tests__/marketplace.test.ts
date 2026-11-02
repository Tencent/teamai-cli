import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { refreshMarketplace } from '../resources/marketplace.js';

let repo: string;

function writeMarketplace(content: string): string {
  const file = path.join(repo, '.codebuddy-plugin', 'marketplace.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);

  return file;
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-marketplace-'));
  fs.mkdirSync(path.join(repo, 'skills', 'release'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'skills', 'release', 'SKILL.md'), '---\ndescription: Cut a release\n---\n');
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('refreshMarketplace', () => {
  it('adds a new skill and keeps the rest of the file as written', async () => {
    const file = writeMarketplace(JSON.stringify({ owner: { name: 'team' }, plugins: [{ source: './x', name: 'manual' }], name: 'm' }));

    await expect(refreshMarketplace(repo)).resolves.toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(`${JSON.stringify({
      owner: { name: 'team' },
      plugins: [
        { source: './x', name: 'manual' },
        { name: 'release', source: './skills/release', description: 'Cut a release', version: '1.0.0', strict: false },
      ],
      name: 'm',
    }, null, 2)}\n`);
  });

  it('leaves a marketplace.json that holds no object alone', async () => {
    const file = writeMarketplace('null');

    await expect(refreshMarketplace(repo)).resolves.toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('null');
  });

  it('leaves a plugins list with an entry that is not an object alone', async () => {
    const file = writeMarketplace('{"plugins":[null]}');

    await expect(refreshMarketplace(repo)).resolves.toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"plugins":[null]}');
  });
});
