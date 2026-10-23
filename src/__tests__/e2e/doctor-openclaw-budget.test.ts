import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import YAML from 'yaml';
import { TEAMAI_CLAUDEMD_START, TEAMAI_CLAUDEMD_END } from '../../types.js';

const CLI = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
it('reports whole-file truncation through the real doctor CLI and clears it after shortening', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-openclaw-budget-e2e-'));
  const home = path.join(root, 'home');
  const repo = path.join(root, 'repo');
  const write = (file: string, content: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
  const env = { ...process.env, HOME: home, USERPROFILE: home, FORCE_COLOR: '0', OPENCLAW_STATE_DIR: path.join(home, '.openclaw'), OPENCLAW_CONFIG_PATH: path.join(home, '.openclaw', 'openclaw.json') };
  try {
    write(path.join(repo, 'teamai.yaml'), YAML.stringify({ team: 'fixture', repo: 'https://example.invalid/team.git', provider: 'git' }));
    write(path.join(home, '.teamai', 'config.yaml'), YAML.stringify({ repo: { localPath: repo, remote: 'https://example.invalid/team.git', kind: 'git' }, username: 'fixture', scope: 'user', enabledAgents: ['openclaw'], updatePolicy: 'skip' }));
    write(path.join(home, '.openclaw', 'openclaw.json'), JSON.stringify({ agents: { defaults: { bootstrapMaxChars: 1000 } } }));
    const file = path.join(home, '.openclaw', 'workspace', 'AGENTS.md');
    const block = `\n${TEAMAI_CLAUDEMD_START}\nTeam instructions.\n${TEAMAI_CLAUDEMD_END}`;
    const run = () => {
      const result = spawnSync(process.execPath, [CLI, 'doctor', '--json'], { cwd: home, env, encoding: 'utf8', timeout: 45000 });
      expect(result.error).toBeUndefined();
      const report = JSON.parse(result.stdout) as { checks: { name: string; ok: boolean; fix: string }[] };
      const check = report.checks.find(check => check.name === 'OpenClaw AGENTS.md fits the default bootstrap read budget');
      expect(check, result.stdout + result.stderr).toBeDefined();
      return check!;
    };
    write(file, 'x'.repeat(1000) + block);
    expect(run().ok).toBe(false);
    expect(run().fix).toContain('bootstrapMaxChars');
    expect(fs.readFileSync(file, 'utf8')).toBe('x'.repeat(1000) + block);
    write(file, block);
    expect(run().ok).toBe(true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 120000);
