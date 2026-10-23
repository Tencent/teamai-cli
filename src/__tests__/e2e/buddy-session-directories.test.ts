import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const CLI = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));

it('migrates into and reads back a native CodeBuddy project directory through the real CLI', () => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-buddy-e2e-')));
  try {
    const source = path.join(home, 'source');
    const target = path.join(home, 'my--project space');
    fs.mkdirSync(path.join(home, '.codebuddy', 'projects'), { recursive: true });
    fs.mkdirSync(source);
    fs.mkdirSync(target);
    const id = '6f0c2a9e-3b1d-4e5f-8a7b-9c0d1e2f3a4b';
    const dir = path.join(home, '.claude', 'projects', source.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), JSON.stringify({
      sessionId: id, cwd: source, type: 'user', uuid: 'user-1', parentUuid: null,
      timestamp: '2026-10-01T09:00:00.000Z', message: { role: 'user', content: 'Native Buddy directory.' },
    }) + '\n');
    const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), FORCE_COLOR: '0' };
    const migrate = (sessionId: string, from: string, to: string, cwd: string, destination: string) => {
      const result = spawnSync(process.execPath, [CLI, 'session', 'migrate', sessionId, '-s', from, '-t', to, '--cwd', cwd, '--target-cwd', destination, '--json', '-y'], {
        cwd: source, env, encoding: 'utf8', timeout: 30_000,
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const reply = JSON.parse(result.stdout);
      expect(reply.error, result.stderr).toBeUndefined();
      return reply.data.sessionId as string;
    };
    const copied = migrate(id, 'claude-code', 'codebuddy', source, target);
    const nativeName = target.replace(/[/\\:]/g, '-').replace(/^-+|-+$/g, '').replace(/-+/g, '-');
    expect(fs.existsSync(path.join(home, '.codebuddy', 'projects', nativeName, `${copied}.jsonl`))).toBe(true);
    const restored = migrate(copied, 'codebuddy', 'claude-code', target, source);
    expect(fs.readFileSync(path.join(dir, `${restored}.jsonl`), 'utf8')).toContain('Native Buddy directory.');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
