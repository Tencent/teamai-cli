import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  describeInstallation,
  installationNotes,
  readInstallations,
  registerRunningInstallation,
  registersRunningInstallation,
  selectOtherInstallation,
  setInstallationUpdate,
  type InstallationRecord,
} from '../installations.js';

let home: string;
let previousHome: string | undefined;

function installationsFile(): string {
  return path.join(home, '.teamai', 'installations.json');
}

function writeInventory(records: InstallationRecord[]): void {
  fs.mkdirSync(path.dirname(installationsFile()), { recursive: true });
  fs.writeFileSync(installationsFile(), JSON.stringify({ version: 1, installations: records }));
}

function npmCopy(prefix: string, version: string, seen = '2026-11-09T00:00:00.000Z'): InstallationRecord {
  const pkgDir = path.join(prefix, 'lib', 'node_modules', 'teamai-cli');
  const entry = path.join(pkgDir, 'dist', 'installations.js');

  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'teamai-cli', version }));

  return {
    id: `${version}-${prefix}`,
    entry,
    version,
    method: 'npm-global',
    prefix,
    autoUpdateSupported: true,
    lastSeenAt: seen,
    lastUpdateAt: null,
    lastUpdateOutcome: null,
    lastUpdateMessage: null,
  };
}

beforeEach(() => {
  previousHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-installations-'));
  process.env.HOME = home;
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });

  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
});

describe('describeInstallation', () => {
  it('reads an npm-global prefix and its version from the entry path', () => {
    const prefix = path.join(home, 'npm-prefix');
    const record = npmCopy(prefix, '0.29.0');

    expect(describeInstallation(record.entry, '0.29.0')).toMatchObject({
      method: 'npm-global',
      prefix,
      version: '0.29.0',
    });
  });

  it('records a Volta image as unsupported instead of an npm prefix', () => {
    const entry = path.join(
      home,
      '.volta',
      'tools',
      'image',
      'packages',
      'teamai-cli',
      'lib',
      'node_modules',
      'teamai-cli',
      'dist',
      'installations.js',
    );

    expect(describeInstallation(entry, '0.29.0').method).toBe('volta');
  });

  it('records a checkout that is not under node_modules as local', () => {
    expect(describeInstallation(path.join(home, 'checkout', 'dist', 'installations.js'), '0.29.0')).toMatchObject({
      method: 'local',
      prefix: null,
    });
  });
});

describe('registerRunningInstallation', () => {
  it('does not create ~/.teamai when the home does not exist', () => {
    expect(registerRunningInstallation()).toBeNull();
    expect(fs.existsSync(path.join(home, '.teamai'))).toBe(false);
  });

  it('records the running copy once and keeps its update result on a later run', () => {
    fs.mkdirSync(path.join(home, '.teamai'));

    const first = registerRunningInstallation(Date.parse('2026-11-09T10:00:00.000Z'));

    expect(first).not.toBeNull();
    expect(readInstallations()).toHaveLength(1);

    setInstallationUpdate(first!.id, 'failed', 'npm reported success but nothing changed');

    const second = registerRunningInstallation(Date.parse('2026-11-09T10:30:00.000Z'));

    expect(second?.lastUpdateOutcome).toBe('failed');
  });

  it('refreshes lastSeenAt after the throttle window', () => {
    fs.mkdirSync(path.join(home, '.teamai'));

    registerRunningInstallation(Date.parse('2026-11-09T10:00:00.000Z'));

    const later = registerRunningInstallation(Date.parse('2026-11-09T12:00:00.000Z'));

    expect(later?.lastSeenAt).toBe('2026-11-09T12:00:00.000Z');
  });

  it('does not record during a dry run', () => {
    fs.mkdirSync(path.join(home, '.teamai'));
    process.env.TEAMAI_DRY_RUN = '1';

    try {
      expect(registerRunningInstallation()).toBeNull();
      expect(fs.existsSync(installationsFile())).toBe(false);
    } finally {
      delete process.env.TEAMAI_DRY_RUN;
    }
  });

  it('never throws when the home cannot be written', () => {
    const teamai = path.join(home, '.teamai');

    fs.mkdirSync(teamai);
    fs.chmodSync(teamai, 0o555);

    try {
      expect(() => registerRunningInstallation()).not.toThrow();
    } finally {
      fs.chmodSync(teamai, 0o755);
    }
  });
});

describe('registersRunningInstallation', () => {
  it('registers a command and a hook', () => {
    expect(registersRunningInstallation(['pull'])).toBe(true);
    expect(registersRunningInstallation(['-v', 'hook', 'stop'])).toBe(true);
    expect(registersRunningInstallation(['recall', 'search', 'uninstall'])).toBe(true);
  });

  it('skips help, version, a dry run and uninstall', () => {
    expect(registersRunningInstallation([])).toBe(false);
    expect(registersRunningInstallation(['pull', '--help'])).toBe(false);
    expect(registersRunningInstallation(['-V'])).toBe(false);
    expect(registersRunningInstallation(['--dry-run', 'pull'])).toBe(false);
    expect(registersRunningInstallation(['uninstall', '--force'])).toBe(false);
    expect(registersRunningInstallation(['-v', 'uninstall'])).toBe(false);
  });
});

describe('readInstallations', () => {
  it('keeps the readable records when one record is corrupt', () => {
    const record = npmCopy(path.join(home, 'a'), '0.28.0');

    fs.mkdirSync(path.dirname(installationsFile()), { recursive: true });
    fs.writeFileSync(installationsFile(), JSON.stringify({ version: 1, installations: [record, { id: 'broken' }] }));

    expect(readInstallations()).toHaveLength(1);
  });
});

describe('selectOtherInstallation', () => {
  const running = (): string => path.join(home, 'running', 'lib', 'node_modules', 'teamai-cli', 'dist', 'installations.js');

  it('chooses the most recently seen outdated npm-global copy', () => {
    const older = npmCopy(path.join(home, 'a'), '0.27.0', '2026-11-09T08:00:00.000Z');
    const newer = npmCopy(path.join(home, 'b'), '0.28.0', '2026-11-09T09:00:00.000Z');

    writeInventory([older, newer]);

    expect(selectOtherInstallation('0.29.0', running())?.id).toBe(newer.id);
  });

  it('skips the running copy, current copies, Volta and local checkouts', () => {
    const current = npmCopy(path.join(home, 'current'), '0.29.0');
    const self = npmCopy(path.join(home, 'running'), '0.20.0');

    self.id = describeInstallation(self.entry, self.version).id;

    const volta = { ...npmCopy(path.join(home, '.volta', 'tools', 'image', 'packages', 'teamai-cli'), '0.20.0'), method: 'volta' as const };
    const local = { ...npmCopy(path.join(home, 'checkout'), '0.20.0'), method: 'local' as const, prefix: null };

    writeInventory([current, self, volta, local]);

    expect(selectOtherInstallation('0.29.0', running())).toBeNull();
  });

  it('leaves a failed copy behind a copy that has never been tried', () => {
    const tried = npmCopy(path.join(home, 'b'), '0.28.0', '2026-11-09T10:00:00.000Z');
    const neverTried = npmCopy(path.join(home, 'c'), '0.27.0', '2026-11-09T08:00:00.000Z');

    writeInventory([
      { ...tried, lastUpdateAt: '2026-11-09T10:05:00.000Z', lastUpdateOutcome: 'failed' },
      neverTried,
    ]);

    expect(selectOtherInstallation('0.29.0', running())?.id).toBe(neverTried.id);
  });

  it('trusts the package.json on disk over the recorded version', () => {
    const record = npmCopy(path.join(home, 'a'), '0.29.0');

    writeInventory([{ ...record, version: '0.20.0' }]);

    expect(selectOtherInstallation('0.29.0', running())).toBeNull();
  });
});

describe('installationNotes', () => {
  it('names the manual remedy for each unsupported method', () => {
    writeInventory([
      npmCopy(path.join(home, 'a'), '0.28.0'),
      { ...npmCopy(path.join(home, '.volta', 'tools', 'image', 'packages', 'teamai-cli'), '0.27.0'), method: 'volta' },
      { ...npmCopy(path.join(home, 'checkout'), '0.26.0'), method: 'local', prefix: null },
    ]);

    const notes = installationNotes();

    expect(notes.some((note) => note.includes('volta install teamai-cli@latest'))).toBe(true);
    expect(notes.some((note) => note.includes('local checkout'))).toBe(true);
    expect(notes.some((note) => note.includes('npm prefix'))).toBe(true);
  });

  it('marks a recorded copy whose directory is gone as missing', () => {
    const record = npmCopy(path.join(home, 'gone'), '0.28.0');

    writeInventory([record]);
    fs.rmSync(path.join(home, 'gone'), { recursive: true, force: true });

    expect(installationNotes()[0]).toContain('no longer on disk');
  });
});
