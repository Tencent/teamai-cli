import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import YAML from 'yaml';

const cli = path.resolve('dist/index.js');

it('switches and restores a team catalog with the built CLI', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-model-cli-'));
  try {
    const home = path.join(sandbox, 'home');
    const teamHome = path.join(home, '.teamai');
    const repo = path.join(teamHome, 'team-repo');
    const claudeDir = path.join(home, 'custom-claude');
    const codexDir = path.join(home, 'custom-codex');
    const xdgDir = path.join(home, 'custom-xdg');
    const opencodeDir = path.join(xdgDir, 'opencode');
    const codebuddyDir = path.join(home, '.codebuddy');
    const workbuddyDir = path.join(home, '.workbuddy');
    await fs.mkdir(path.join(repo, 'models'), { recursive: true });
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.mkdir(codexDir, { recursive: true });
    await fs.mkdir(opencodeDir, { recursive: true });
    await fs.mkdir(codebuddyDir, { recursive: true });
    await fs.mkdir(workbuddyDir, { recursive: true });
    await fs.writeFile(path.join(repo, 'teamai.yaml'), YAML.stringify({ team: 'HAIHub test', repo: 'https://example.invalid/team.git' }));
    await fs.writeFile(path.join(teamHome, 'config.yaml'), YAML.stringify({ repo: { kind: 'git', localPath: repo, remote: 'https://example.invalid/team.git' }, username: 'tester', scope: 'user' }));
    await fs.writeFile(path.join(repo, 'models', 'models.yaml'), YAML.stringify({ profiles: [{
      id: 'tokenhub', name: 'Tencent TokenHub', base_url: 'https://gateway.example.test', api_key: '${API_KEY}',
      model_groups: [
        { protocols: ['anthropic'], models: ['claude-opus-4-8', 'claude-sonnet-4-6'] },
        { protocols: ['anthropic', 'openai-chat-completions', 'openai-responses'], models: ['deepseek-v4-flash'] },
      ],
    }] }));
    await fs.mkdir(path.join(teamHome, 'models'), { recursive: true });
    await fs.writeFile(path.join(teamHome, 'models', 'models.yaml'), 'profiles: []\n');
    const originalClaude = { permissions: { allow: ['Read'] }, env: { KEEP: 'yes', ANTHROPIC_API_KEY: 'original-key', ANTHROPIC_CUSTOM_HEADERS: 'X-Private: original' } };
    const originalOpenCode = { instructions: ['keep.md'], plugin: ['example'] };
    const originalBuddy = { models: [{ id: 'personal', name: 'Personal' }], availableModels: ['personal'], ui: { theme: 'dark' } };
    const originalCodex = '# keep comment\nmodel = "personal"\n';
    await fs.writeFile(path.join(claudeDir, 'settings.json'), JSON.stringify(originalClaude));
    await fs.writeFile(path.join(codexDir, 'config.toml'), originalCodex);
    await fs.writeFile(path.join(opencodeDir, 'opencode.json'), JSON.stringify(originalOpenCode));
    await fs.writeFile(path.join(codebuddyDir, 'models.json'), JSON.stringify(originalBuddy));
    await fs.writeFile(path.join(workbuddyDir, 'models.json'), JSON.stringify(originalBuddy));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: claudeDir,
      CODEX_HOME: codexDir,
      XDG_CONFIG_HOME: xdgDir,
      FIXTURE_MODEL_KEY: 'fixture-key',
      NO_COLOR: '1',
    };
    delete env.OPENCODE_CONFIG;
    const run = (...args: string[]) => execFileSync(process.execPath, [cli, 'models', ...args], { cwd: home, env, encoding: 'utf8' });

    expect(run('list')).toContain('team:tokenhub');
    expect(run('configure', 'team:tokenhub', '--from-env', 'FIXTURE_MODEL_KEY')).toContain('Configured team:tokenhub');
    const switched = run('switch', 'tokenhub');
    for (const agent of ['claude', 'codex', 'opencode', 'codebuddy', 'workbuddy']) {
      expect(switched).toContain(`${agent} switched to team:tokenhub`);
    }
    expect(run('list', 'tokenhub')).toContain('  Active: claude, codex, opencode, codebuddy, workbuddy');
    const claude = JSON.parse(await fs.readFile(path.join(claudeDir, 'settings.json'), 'utf8'));
    const opencode = JSON.parse(await fs.readFile(path.join(opencodeDir, 'opencode.json'), 'utf8'));
    expect(claude.permissions).toEqual(originalClaude.permissions);
    expect(claude.env.KEEP).toBe('yes');
    expect(claude.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(claude.env).not.toHaveProperty('ANTHROPIC_CUSTOM_HEADERS');
    expect(claude.modelPicker.options).toHaveLength(3);
    expect(opencode.instructions).toEqual(originalOpenCode.instructions);
    expect(opencode.provider['teamai-chat'].models).toHaveProperty('deepseek-v4-flash');
    const codex = await fs.readFile(path.join(codexDir, 'config.toml'), 'utf8');
    expect(codex).toContain('model = "deepseek-v4-flash"');
    expect(codex).toContain('env_key = "FIXTURE_MODEL_KEY"');
    expect(codex).toContain('wire_api = "responses"');
    for (const dir of [codebuddyDir, workbuddyDir]) {
      const buddy = JSON.parse(await fs.readFile(path.join(dir, 'models.json'), 'utf8'));
      expect(buddy.ui).toEqual(originalBuddy.ui);
      expect(buddy.models.map((item: { id: string }) => item.id)).toEqual(['personal', 'deepseek-v4-flash']);
      expect(buddy.models[1].apiKey).toBe('${FIXTURE_MODEL_KEY}');
      expect(buddy.availableModels).toEqual(['personal', 'deepseek-v4-flash']);
    }
    expect(run('restore')).toContain('workbuddy model settings restored');
    expect(JSON.parse(await fs.readFile(path.join(claudeDir, 'settings.json'), 'utf8'))).toEqual(originalClaude);
    expect(JSON.parse(await fs.readFile(path.join(opencodeDir, 'opencode.json'), 'utf8'))).toEqual(originalOpenCode);
    const restoredCodex = await fs.readFile(path.join(codexDir, 'config.toml'), 'utf8');
    expect(restoredCodex).toContain('# keep comment');
    expect(restoredCodex).toMatch(/^model = "personal"$/m);
    expect(restoredCodex).not.toContain('[model_providers.teamai]');
    for (const dir of [codebuddyDir, workbuddyDir]) {
      expect(JSON.parse(await fs.readFile(path.join(dir, 'models.json'), 'utf8'))).toEqual(originalBuddy);
    }
    const remote = path.join(sandbox, 'remote.git');
    execFileSync('git', ['init', '--bare', '--initial-branch=main', remote]);
    execFileSync('git', ['init', '--initial-branch=main', repo]);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo });
    git('config', 'user.name', 'TeamAI Test');
    git('config', 'user.email', 'teamai@example.test');
    git('add', '.');
    git('commit', '-m', 'valid catalog');
    git('remote', 'add', 'origin', remote);
    git('push', '-u', 'origin', 'main');
    await fs.writeFile(path.join(repo, 'models', 'models.yaml'), YAML.stringify({ profiles: [], credentials: 'unexpected' }));
    git('add', '.');
    git('commit', '-m', 'invalid catalog');
    git('push', 'origin', 'main');
    const blocked = spawnSync(process.execPath, [cli, 'push', '--all'], { cwd: home, env, encoding: 'utf8' });
    expect(blocked.status).toBe(1);
    expect(`${blocked.stdout}${blocked.stderr}`).toContain('Cannot push with an invalid model catalog');
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});
