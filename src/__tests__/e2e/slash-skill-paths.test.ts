import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../../../dist/index.js', import.meta.url));
let sandbox: string;

afterEach(() => {
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('real CLI slash skill tracking (#1132)', () => {
  it.each(['hook-dispatch', 'track-slash'])('%s ignores paths and records a valid skill', (entry) => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-slash-paths-'));
    const home = path.join(sandbox, 'home');
    const dataHome = path.join(home, '.teamai');
    const repo = path.join(sandbox, 'team-repo');
    fs.mkdirSync(dataHome, { recursive: true });
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(dataHome, 'config.yaml'), [
      'repo:', `  localPath: ${JSON.stringify(repo)}`,
      '  remote: https://example.test/team/repo.git',
      'username: tester', 'scope: user', 'updatePolicy: skip', '',
    ].join('\n'));
    fs.writeFileSync(path.join(repo, 'teamai.yaml'),
      'team: slash-paths\nrepo: https://example.test/team/repo.git\nprovider: git\nusageReport: false\n');
    for (const name of ['tdd', 'Volumes', 'External', 'project']) {
      const directory = path.join(home, '.claude', 'skills', name);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'SKILL.md'), `# ${name}\n`);
    }

    const run = (prompt: string) => {
      const args = entry === 'hook-dispatch'
        ? ['hook-dispatch', 'prompt-submit', '--tool', 'claude']
        : ['track-slash', '--stdin', '--tool', 'claude'];
      const result = spawnSync(process.execPath, [cli, ...args], {
        cwd: sandbox,
        env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), FORCE_COLOR: '0' },
        input: JSON.stringify({ prompt, cwd: sandbox, session_id: 'slash-paths', hook_event_name: 'UserPromptSubmit' }),
        encoding: 'utf8', windowsHide: true, timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    };

    run('/Volumes/External/project/.claude/skills/tdd/SKILL.md');
    expect(fs.existsSync(path.join(dataHome, 'user-usage.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(dataHome, 'known-skills.json'))).toBe(false);

    run('/tdd /Volumes/External/project https://example.test/project /tdd/notes');
    const events = fs.readFileSync(path.join(dataHome, 'user-usage.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line) as { skill: string });
    expect(events.map((event) => event.skill)).toEqual(['tdd']);
    expect(JSON.parse(fs.readFileSync(path.join(dataHome, 'known-skills.json'), 'utf8'))).toEqual(['tdd']);
  });
});
