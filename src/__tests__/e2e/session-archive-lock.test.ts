import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));

describe('session migration and archive (real CLI, #1140)', () => {
  it('renders one JSON result, copies once, and archives through the locked entry point', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-session-archive-cli-')));
    const home = path.join(dir, 'home');
    const cwd = path.join(dir, 'workspace');
    const archive = path.join(dir, 'archive');
    const remote = path.join(dir, 'remote.git');
    const id = 'b491bc32-9df6-43cc-a90c-85fdf481199e';
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, FORCE_COLOR: '0',
      GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
    delete env.CLAUDE_CONFIG_DIR;
    const run = (command: string, args: string[], working = cwd) => spawnSync(command, args, { cwd: working, env, encoding: 'utf8', timeout: 30_000 });
    try {
      fs.mkdirSync(cwd, { recursive: true });
      fs.mkdirSync(path.join(home, '.codebuddy', 'projects'), { recursive: true });
      const source = path.join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
      fs.mkdirSync(source, { recursive: true });
      const base = { sessionId: id, cwd, isSidechain: false };
      const lines = [
        { ...base, type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-10-23T00:00:00Z', message: { role: 'user', content: 'Explain archive locks.' } },
        { ...base, type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-10-23T00:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Serialize archive writers.' }] } },
      ];
      fs.writeFileSync(path.join(source, `${id}.jsonl`), lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
      expect(run('git', ['init', '-q', '--bare', '-b', 'main', remote]).status).toBe(0);
      expect(run('git', ['clone', '-q', remote, archive]).status).toBe(0);
      const args = [cli, 'session', 'migrate', id, '-s', 'claude-code', '-t', 'codebuddy', '--cwd', cwd];
      const preview = run(process.execPath, [...args, '--json', '--dry-run']);
      expect(preview.status, preview.stderr).toBe(0);
      expect(JSON.parse(preview.stdout)).toMatchObject({ data: { dryRun: true } });
      const copied = run(process.execPath, [...args, '--json', '--push', '--scrub', '-y', '--repo-root', archive]);
      expect(copied.status, copied.stderr).toBe(0);
      const result = JSON.parse(copied.stdout);
      expect(result).toMatchObject({ data: { reused: false } });
      const again = run(process.execPath, [...args, '--json']);
      expect(again.status, again.stderr).toBe(0);
      expect(JSON.parse(again.stdout)).toMatchObject({ data: { sessionId: result.data.sessionId, reused: true } });
      const indexes = run(process.execPath, [cli, 'session', 'pull', '--all', '--repo-root', archive]);
      expect(indexes.status, indexes.stderr).toBe(0);
      expect(indexes.stdout).toContain('indexed 1 session(s)');
      expect(run('git', ['ls-tree', '-r', '--name-only', 'main'], remote).stdout).toContain('_index.json');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
