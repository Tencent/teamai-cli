import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import { resolveHomeDir } from '../utils/home.js';

describe('resolveHomeDir', () => {
  const origPlatform = process.platform;
  const origHome = process.env.HOME;
  const origUserProfile = process.env.USERPROFILE;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: origPlatform });
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = origUserProfile;
  });

  it('non-Windows: returns HOME when set', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    process.env.HOME = '/home/alice';
    expect(resolveHomeDir()).toBe('/home/alice');
  });

  it('non-Windows: falls back to os.homedir() when HOME is empty', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    process.env.HOME = '';
    expect(resolveHomeDir()).toBe(os.homedir());
  });

  it('Windows: prefers USERPROFILE over a shell-injected HOME', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.HOME = '/home/gitbashuser';
    process.env.USERPROFILE = 'C:\\Users\\bob';
    expect(resolveHomeDir()).toBe('C:\\Users\\bob');
  });

  it('Windows: falls back to os.homedir() when USERPROFILE is unset', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    delete process.env.USERPROFILE;
    process.env.HOME = '/home/gitbashuser';
    expect(resolveHomeDir()).toBe(os.homedir());
  });
});
