import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import YAML from 'yaml';
import { TEAMAI_RULES_START, TEAMAI_RULES_END } from '../../types.js';

const CLI = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
it('reports whole-file truncation through the real doctor CLI and clears it after shortening', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-hermes-budget-e2e-'));
  const home = path.join(root, 'home');
  const repo = path.join(root, 'repo');
  const write = (file: string, content: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
  const env = { ...process.env, HOME: home, USERPROFILE: home, FORCE_COLOR: '0', HERMES_HOME: path.join(home, '.hermes') };
  try {
    write(path.join(repo, 'teamai.yaml'), YAML.stringify({ team: 'fixture', repo: 'https://example.invalid/team.git', provider: 'git' }));
    write(path.join(home, '.teamai', 'config.yaml'), YAML.stringify({ repo: { localPath: repo, remote: 'https://example.invalid/team.git', kind: 'git' }, username: 'fixture', scope: 'user', enabledAgents: ['hermes'], updatePolicy: 'skip' }));
    write(path.join(home, '.hermes', 'config.yaml'), 'context_file_max_chars: 1000\n');
    const file = path.join(home, '.hermes', 'SOUL.md');
    const block = `\n${TEAMAI_RULES_START}\nTeam rules.\n${TEAMAI_RULES_END}`;
    const run = () => {
      const result = spawnSync(process.execPath, [CLI, 'doctor', '--json'], { cwd: home, env, encoding: 'utf8', timeout: 45000 });
      expect(result.error).toBeUndefined();
      const report = JSON.parse(result.stdout) as { checks: { name: string; ok: boolean; fix: string }[] };
      const check = report.checks.find(check => check.name === 'Hermes SOUL.md fits the context-file read budget');
      expect(check, result.stdout + result.stderr).toBeDefined();
      return check!;
    };
    write(file, 'x'.repeat(1000) + block);
    expect(run().ok).toBe(false);
    expect(run().fix).toContain('context_file_max_chars');
    expect(fs.readFileSync(file, 'utf8')).toBe('x'.repeat(1000) + block);
    write(file, block);
    expect(run().ok).toBe(true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 120000);
