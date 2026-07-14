import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('ora', () => ({
  default: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
}));
vi.mock('chalk', () => ({
  default: { blue: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s, red: (s: string) => s, gray: (s: string) => s, dim: (s: string) => s },
}));

import { log, setVerbose, setSilent, setStderrOnly, MAX_LOG_BYTES, _setLogFilePath, _resetState } from '../utils/logger.js';

let tmpDir: string;
let logFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'));
  logFile = path.join(tmpDir, 'debug.log');
  _setLogFilePath(logFile);
  setVerbose(false);
  setSilent(false);
  setStderrOnly(false);
});

afterEach(() => {
  _resetState();
  setVerbose(false);
  setSilent(false);
  setStderrOnly(false);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('file transport', () => {
  it('writes debug to file', () => {
    log.debug('hello from debug');
    expect(fs.readFileSync(logFile, 'utf-8')).toContain('[DEBUG] hello from debug');
  });

  it('writes error to file', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    log.error('something broke');
    spy.mockRestore();
    expect(fs.readFileSync(logFile, 'utf-8')).toContain('[ERROR] something broke');
  });

  it('includes timestamp', () => {
    log.debug('ts');
    expect(fs.readFileSync(logFile, 'utf-8').trim()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('appends multiple', () => {
    log.debug('one');
    log.debug('two');
    log.debug('three');
    expect(fs.readFileSync(logFile, 'utf-8').trim().split('\n')).toHaveLength(3);
  });

  it('creates dir', () => {
    const nested = path.join(tmpDir, 'sub', 'debug.log');
    _setLogFilePath(nested);
    log.debug('x');
    expect(fs.existsSync(nested)).toBe(true);
  });

  it('silent fail on bad path', () => {
    // Use a file as parent to trigger ENOTDIR on mkdirSync
    const blocker = path.join(tmpDir, 'file-not-dir');
    fs.writeFileSync(blocker, 'x');
    _setLogFilePath(path.join(blocker, 'child', 'debug.log'));
    expect(() => log.debug('ok')).not.toThrow();
  });

  it('no recurse on dir-as-file', () => {
    // Make logFile a directory so appendFileSync fails with EISDIR
    fs.mkdirSync(logFile);
    expect(() => log.debug('ok')).not.toThrow();
  });
});

describe('console', () => {
  it('no console when verbose off', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    log.debug('hidden');
    expect(spy.mock.calls.filter(a => String(a[1]).includes('hidden'))).toHaveLength(0);
    spy.mockRestore();
  });

  it('console when verbose on', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    setVerbose(true);
    log.debug('visible');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('file even when silent', () => {
    setSilent(true);
    log.debug('silent');
    expect(fs.readFileSync(logFile, 'utf-8')).toContain('silent');
  });
});

describe('levels', () => {
  it('[DEBUG] tag', () => {
    log.debug('d');
    const c = fs.readFileSync(logFile, 'utf-8');
    expect(c).toContain('[DEBUG]');
    expect(c).not.toContain('[ERROR]');
  });

  it('[ERROR] tag', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    log.error('e');
    spy.mockRestore();
    const c = fs.readFileSync(logFile, 'utf-8');
    expect(c).toContain('[ERROR]');
    expect(c).not.toContain('[DEBUG]');
  });

  it('both in order', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    log.debug('d');
    log.error('e');
    spy.mockRestore();
    const lines = fs.readFileSync(logFile, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('[DEBUG]');
    expect(lines[1]).toContain('[ERROR]');
  });
});

describe('stderr-only mode (hook-dispatch path)', () => {
  it('routes info to stderr when enabled, keeping stdout clean', () => {
    const stdoutSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setStderrOnly(true);
    log.info('hook progress');
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalled();
    expect(String(stderrSpy.mock.calls[0][0])).toContain('hook progress');
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('routes success/warn to stderr when enabled', () => {
    const stdoutSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setStderrOnly(true);
    log.success('done');
    log.warn('be careful');
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledTimes(2);
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('keeps error on stderr (unchanged behavior)', () => {
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setStderrOnly(true);
    log.error('boom');
    expect(stderrSpy).toHaveBeenCalled();
    stderrSpy.mockRestore();
  });

  it('reverts to stdout when disabled', () => {
    const stdoutSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    setStderrOnly(true);
    setStderrOnly(false);
    log.info('back to normal');
    expect(stdoutSpy).toHaveBeenCalled();
    stdoutSpy.mockRestore();
  });
});

describe('rotation', () => {
  it('rotates when file exceeds limit', () => {
    // Write 6MB to exceed 5MB limit
    const fd = fs.openSync(logFile, 'w');
    const chunk = Buffer.alloc(1024 * 1024, 0x78); // 1MB of 'x'
    for (let i = 0; i < 6; i++) fs.writeSync(fd, chunk);
    fs.closeSync(fd);

    log.debug('after rotation');

    expect(fs.existsSync(logFile + '.1')).toBe(true);
    const current = fs.readFileSync(logFile, 'utf-8');
    expect(current).toContain('after rotation');
    expect(current.length).toBeLessThan(200);
  });

  it('does not rotate small files', () => {
    fs.writeFileSync(logFile, 'small');
    log.debug('appended');
    expect(fs.existsSync(logFile + '.1')).toBe(false);
    const c = fs.readFileSync(logFile, 'utf-8');
    expect(c).toContain('small');
    expect(c).toContain('appended');
  });

  it('works on first write (no file yet)', () => {
    log.debug('first');
    expect(fs.readFileSync(logFile, 'utf-8')).toContain('first');
  });

  it('rotates at exact MAX_LOG_BYTES boundary', () => {
    const fd = fs.openSync(logFile, 'w');
    const chunk = Buffer.alloc(1024 * 1024, 0x7a); // 1MB of 'z'
    for (let i = 0; i < 5; i++) fs.writeSync(fd, chunk); // 5MB = MAX_LOG_BYTES
    fs.closeSync(fd);

    log.debug('boundary');
    expect(fs.existsSync(logFile + '.1')).toBe(true);
  });
});
