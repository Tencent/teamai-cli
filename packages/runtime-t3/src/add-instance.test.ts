import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addProviderInstance, type NewInstance } from './add-instance.js';

describe('addProviderInstance', () => {
  let dir: string;
  let settingsFile: string;
  const instance: NewInstance = { id: 'acme-claude', driver: 'claudeAgent', displayName: 'acme-claude', command: 'acme-claude', binaryPath: '/opt/acme/bin/acme-claude' };
  const added = { driver: 'claudeAgent', displayName: 'acme-claude', enabled: true, config: { binaryPath: '/opt/acme/bin/acme-claude' } };

  beforeEach(() => {
    // The runtime writes beside the settings file's real path: on macOS the temp folder is behind a link.
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-add-instance-')));
    settingsFile = path.join(dir, 't3', 'userdata', 'settings.json');
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const add = () => addProviderInstance({ t3Home: path.join(dir, 't3'), lockFile: path.join(dir, 'settings.lock'), userHome: dir, instance });

  /** T3 Code writes its settings while teamai writes its copy, for the first `times` copies teamai writes. */
  const t3WritesWhileTeamaiWrites = (times: number, write: (attempt: number) => string): void => {
    const writeFileSync = fs.writeFileSync.bind(fs);
    let attempt = 0;

    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, data, options) => {
      writeFileSync(file, data, options);

      if (String(file).startsWith(`${settingsFile}.teamai-`) && attempt < times) writeFileSync(settingsFile, write(attempt++));
    });
  };

  it('keeps what T3 Code wrote between teamai\'s read and its write, and adds the instance', async () => {
    fs.writeFileSync(settingsFile, JSON.stringify({ theme: 'light' }));
    t3WritesWhileTeamaiWrites(1, () => JSON.stringify({ theme: 'dark', providerInstances: { cursor: { driver: 'cursor' } } }));

    expect(await add()).toEqual({ kind: 'added', id: 'acme-claude' });
    expect(JSON.parse(fs.readFileSync(settingsFile, 'utf8'))).toEqual({ theme: 'dark', providerInstances: { cursor: { driver: 'cursor' }, 'acme-claude': added } });
  });

  it('tries once more, then gives up and leaves T3 Code\'s file as T3 wrote it, when T3 writes it again each time', async () => {
    fs.writeFileSync(settingsFile, JSON.stringify({ theme: 'light' }));
    t3WritesWhileTeamaiWrites(2, (attempt) => JSON.stringify({ theme: `t3-${attempt}` }));

    expect(await add()).toEqual({ kind: 'failed', why: `T3 Code kept changing its settings file ${settingsFile}` });
    expect(fs.readFileSync(settingsFile, 'utf8')).toBe(JSON.stringify({ theme: 't3-1' }));
    expect(fs.readdirSync(path.dirname(settingsFile))).toEqual(['settings.json']);
  });

  it('keeps every key it does not own as the file holds it, a __proto__ key too', async () => {
    const kept = '{"__proto__":{"polluted":true},"future":{"nested":[1,{"a":null}]},"providerInstances":{"__proto__":{"x":1},"cursor":{"driver":"cursor","config":{"extra":true}}}}';
    fs.writeFileSync(settingsFile, kept);

    expect(await add()).toEqual({ kind: 'added', id: 'acme-claude' });
    const written = fs.readFileSync(settingsFile, 'utf8');

    expect(written.match(/^ {2}"[^"]+":/gm)).toEqual(['  "__proto__":', '  "future":', '  "providerInstances":']);
    expect(written.match(/^ {4}"[^"]+":/gm)).toEqual(['    "polluted":', '    "nested":', '    "__proto__":', '    "cursor":', '    "acme-claude":']);
    expect(written).toContain('"__proto__": {\n    "polluted": true\n  }');
    expect(written).toContain('"__proto__": {\n      "x": 1\n    }');
    expect(written).toContain('"future": {\n    "nested": [\n      1,\n      {\n        "a": null\n      }\n    ]\n  }');
  });

  it.each([['null'], ['[{"driver":"cursor"}]']])('leaves the file as it is when its providerInstances is %s, not an object', async (instances) => {
    const kept = `{"providerInstances":${instances}}`;
    fs.writeFileSync(settingsFile, kept);

    expect(await add()).toEqual({ kind: 'failed', why: `T3 Code's settings file ${settingsFile} has a providerInstances that is not a JSON object` });
    expect(fs.readFileSync(settingsFile, 'utf8')).toBe(kept);
  });
});
