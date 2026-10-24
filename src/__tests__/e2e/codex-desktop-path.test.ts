import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { installFakeCodex, readFakeCodexState } from '../helpers/fake-codex.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../dist/index.js');

describe('hooks inject with ChatGPT.app Codex', () => {
  it('trusts hooks through codex-cli/bin/codex without codex on PATH', () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-desktop-codex-'));
    try {
      const home = path.join(sandbox, 'home');
      const emptyBin = path.join(sandbox, 'bin');
      const teamRepo = path.join(home, '.teamai', 'team-repo');
      const codexHome = path.join(home, '.codex');
      fs.mkdirSync(emptyBin);
      fs.mkdirSync(path.join(teamRepo, 'hooks'), { recursive: true });
      fs.mkdirSync(codexHome, { recursive: true });
      fs.writeFileSync(path.join(teamRepo, 'teamai.yaml'), 'team: desktop-codex\nrepo: https://example.com/team.git\nprovider: git\n');
      fs.writeFileSync(path.join(teamRepo, 'hooks', 'hooks.yaml'), [
        'hooks:',
        '  - id: desktop-stop',
        '    event: Stop',
        '    command: echo desktop-stop',
        '    description: Desktop Codex path fixture',
      ].join('\n'));
      fs.writeFileSync(path.join(home, '.teamai', 'config.yaml'), [
        'repo:', `  localPath: ${JSON.stringify(teamRepo)}`, '  remote: https://example.com/team.git',
        'username: e2e-user', 'scope: user', 'enabledAgents: [codex]', '',
      ].join('\n'));
      const desktop = path.join(installFakeCodex({
        dir: path.join(home, 'Applications', 'ChatGPT.app', 'Contents', 'Resources', 'codex-cli', 'bin'),
        version: '9999.0.0',
      }), 'codex');

      const run = spawnSync(process.execPath, [CLI, 'hooks', 'inject'], {
        cwd: home,
        env: {
          ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome,
          PATH: emptyBin, FORCE_COLOR: '0',
        },
        encoding: 'utf8',
        timeout: 20_000,
      });

      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
      expect(readFakeCodexState(codexHome).calls.map((call) => call.codex)).toContain(desktop);
      expect(Object.keys(readFakeCodexState(codexHome).hooksState).length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
