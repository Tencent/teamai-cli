import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { hasTeamaiHooks } from '../hooks.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-hasteamaihooks-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('hasTeamaiHooks', () => {
  it('returns true when file contains a teamai built-in hook (description prefix)', async () => {
    const settingsPath = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        SessionStart: [
          {
            matcher: '*',
            hooks: [{ type: 'command', command: 'teamai hook-dispatch' }],
            description: '[teamai] hook-dispatch',
          },
        ],
      },
    }));

    expect(await hasTeamaiHooks(settingsPath, 'claude')).toBe(true);
  });

  // CodeBuddy Code 2.179.1 reads settings.json with jsonc-parser; Claude Code 2.1.316 refuses a comment.
  it('reads a commented settings.json as the tool does', async () => {
    const settingsPath = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(settingsPath, '{\n  // the member\'s note\n  "hooks": { "SessionStart": [{ "hooks": [{ "type": "command", "command": "teamai hook-dispatch" }], "description": "[teamai] hook-dispatch" },] },\n}\n');

    expect(await hasTeamaiHooks(settingsPath, 'codebuddy')).toBe(true);
    expect(await hasTeamaiHooks(settingsPath, 'claude')).toBe(false);
  });

  it('returns false when file has only user hooks and manifest has stale record (P2#2 regression)', async () => {
    const settingsPath = path.join(tmpDir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        SessionStart: [
          { matcher: '*', hooks: [{ type: 'command', command: 'echo hi' }] },
        ],
      },
    }));

    const manifestPath = path.join(tmpDir, 'managed-hooks.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      claude: [{ id: 'x', event: 'SessionStart', command: 'teamai pull' }],
    }));

    // stale manifest entry — command not present in file → must return false
    expect(await hasTeamaiHooks(settingsPath, 'claude', manifestPath)).toBe(false);
  });

  it('returns true for codex format when manifest command exists in hooks file', async () => {
    const hooksPath = path.join(tmpDir, 'hooks.json');
    const teamCmd = 'teamai-custom-team-hook';
    fs.writeFileSync(hooksPath, JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: teamCmd }] },
        ],
      },
    }));

    const manifestPath = path.join(tmpDir, 'managed-hooks.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      codex: [{ id: 'y', event: 'SessionStart', command: teamCmd }],
    }));

    expect(await hasTeamaiHooks(hooksPath, 'codex', manifestPath)).toBe(true);
  });
});
