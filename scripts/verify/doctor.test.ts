import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cheapestListed, probeHostCommand, sbxInWorld } from './doctor.js';

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();

  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A script `name` in `dir` that runs `body`. */
function script(dir: string, name: string, body: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

describe('a probe of a command on this machine', () => {
  it("asks the member's own install, never a dependency of this checkout that `npm run` puts first on PATH", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-probe-'));
    roots.push(root);
    script(path.join(root, 'checkout', 'node_modules', '.bin'), 'opencode', 'echo 1.18.23');
    script(path.join(root, 'member', 'bin'), 'opencode', 'echo opencode v2.2.7');
    vi.stubEnv('PATH', `${path.join(root, 'checkout', 'node_modules', '.bin')}:${path.join(root, 'member', 'bin')}:/usr/bin:/bin`);

    expect(probeHostCommand(['opencode', '--version'])).toEqual({ ok: true, first: 'opencode v2.2.7', stdout: 'opencode v2.2.7\n' });
  });

  it('says NOT OBSERVED when the command does not answer in time, and not installed when it is not there', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-probe-'));
    roots.push(root);
    // As Cursor's launcher that finds itself first on a world's PATH: it never ends, and a TERM does not stop it.
    script(path.join(root, 'bin'), 'cursor', 'trap "" TERM\nsleep 30');
    vi.stubEnv('PATH', `${path.join(root, 'bin')}:/usr/bin:/bin`);

    expect(probeHostCommand(['cursor', '--version'], { timeoutMs: 300 })).toEqual({ ok: false, why: 'NOT OBSERVED: cursor --version did not answer within 0.3 s' });
    expect(probeHostCommand(['no-such-tool-here', '--version'])).toEqual({ ok: false, why: 'not installed' });
  });
});

describe("a tool's cheapest model", () => {
  it("is the cheapest by teamai's own prices among those this login lists, never a hidden one or one teamai has no price for", () => {
    const catalog = JSON.stringify({ models: [
      { slug: 'gpt-6-sol', visibility: 'list' },
      { slug: 'gpt-6-luna', visibility: 'list' },
      { slug: 'gpt-5-6-luna', visibility: 'list' },
      { slug: 'nano-preview', visibility: 'hide' },
      { slug: 'unpriced-model', visibility: 'list' },
    ] });

    expect(cheapestListed(catalog)).toBe('gpt-6-luna');
  });

  it('is unknown when the catalog cannot be read', () => {
    expect(cheapestListed('not json')).toBeUndefined();
    expect(cheapestListed(JSON.stringify({ models: [{ slug: 'unpriced-model', visibility: 'list' }] }))).toBeUndefined();
  });
});

describe('sbx in a world', () => {
  const RUN = '20261112T113044-479be0';

  it("is not signed in from a world's own HOME until a maintainer signs in there, and says the command", () => {
    expect(sbxInWorld(RUN, { code: 1, why: 'try: sbx login' })).toEqual({
      good: false,
      text: `sandbox sbx: installed, not signed in in this world; sign in with \`npm run -s verify -- sh ${RUN} sbx login\`. Claims on it are UNVERIFIABLE until then`,
    });
  });

  it('is signed in once its list answers, and unverifiable when the list fails for another reason', () => {
    expect(sbxInWorld(RUN, { code: 0, why: '' })).toEqual({ good: true, text: 'sandbox sbx: signed in in this world' });
    expect(sbxInWorld(RUN, { code: 1, why: 'error: daemon not reachable' })).toEqual({ good: false, text: 'sandbox sbx: `sbx ls` failed in this world (error: daemon not reachable): claims on it are UNVERIFIABLE here' });
  });
});
