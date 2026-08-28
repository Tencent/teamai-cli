import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { seedProjectAgentRoot } from '../project-agent-root.js';

let tmpDir: string;

function writeProjectConfig(opts: {
  projectRoot?: string;
  enabledAgents?: string[];
  disabledAgents?: string[];
  teamYaml?: string;
}): string {
  const projectRoot = opts.projectRoot ?? tmpDir;
  const teamaiDir = path.join(projectRoot, '.teamai');
  const repoPath = path.join(teamaiDir, 'team-repo');
  fs.mkdirSync(repoPath, { recursive: true });
  fs.writeFileSync(
    path.join(teamaiDir, 'config.yaml'),
    YAML.stringify({
      repo: { localPath: repoPath, remote: 'https://example.com/team.git' },
      username: 'ci',
      scope: 'project',
      projectRoot,
      ...(opts.enabledAgents ? { enabledAgents: opts.enabledAgents } : {}),
      ...(opts.disabledAgents ? { disabledAgents: opts.disabledAgents } : {}),
    }),
  );
  if (opts.teamYaml !== undefined) {
    fs.writeFileSync(path.join(repoPath, 'teamai.yaml'), opts.teamYaml);
  }
  return projectRoot;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-seed-agent-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('seedProjectAgentRoot', () => {
  it('creates the current tool root under a project-scope cwd', async () => {
    const projectRoot = writeProjectConfig({});
    expect(fs.existsSync(path.join(projectRoot, '.claude'))).toBe(false);

    await seedProjectAgentRoot('claude', projectRoot);

    expect(fs.existsSync(path.join(projectRoot, '.claude'))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.cursor'))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, '.codebuddy'))).toBe(false);
  });

  it('creates only the requested tool root (cursor, not claude)', async () => {
    const projectRoot = writeProjectConfig({});
    await seedProjectAgentRoot('cursor', projectRoot);
    expect(fs.existsSync(path.join(projectRoot, '.cursor'))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.claude'))).toBe(false);
  });

  it('creates .codebuddy when the hook tool is codebuddy', async () => {
    const projectRoot = writeProjectConfig({});
    await seedProjectAgentRoot('codebuddy', projectRoot);
    expect(fs.existsSync(path.join(projectRoot, '.codebuddy'))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.claude'))).toBe(false);
  });

  it('does nothing when cwd has no project-scope config', async () => {
    await seedProjectAgentRoot('claude', tmpDir);
    expect(fs.existsSync(path.join(tmpDir, '.claude'))).toBe(false);
  });

  it('does nothing for user-scope config in cwd', async () => {
    const teamaiDir = path.join(tmpDir, '.teamai');
    fs.mkdirSync(teamaiDir, { recursive: true });
    fs.writeFileSync(
      path.join(teamaiDir, 'config.yaml'),
      YAML.stringify({
        repo: { localPath: teamaiDir, remote: 'https://example.com/team.git' },
        username: 'ci',
        scope: 'user',
      }),
    );
    await seedProjectAgentRoot('claude', tmpDir);
    expect(fs.existsSync(path.join(tmpDir, '.claude'))).toBe(false);
  });

  it('does not create a disabled agent root', async () => {
    const projectRoot = writeProjectConfig({ disabledAgents: ['claude'] });
    await seedProjectAgentRoot('claude', projectRoot);
    expect(fs.existsSync(path.join(projectRoot, '.claude'))).toBe(false);
  });

  it('does not create a tool missing from enabledAgents', async () => {
    const projectRoot = writeProjectConfig({ enabledAgents: ['cursor'] });
    await seedProjectAgentRoot('claude', projectRoot);
    expect(fs.existsSync(path.join(projectRoot, '.claude'))).toBe(false);
    await seedProjectAgentRoot('cursor', projectRoot);
    expect(fs.existsSync(path.join(projectRoot, '.cursor'))).toBe(true);
  });

  it('does not create an unknown tool root', async () => {
    const projectRoot = writeProjectConfig({});
    await seedProjectAgentRoot('not-a-tool', projectRoot);
    expect(fs.readdirSync(projectRoot).filter((name) => name.startsWith('.'))).toEqual(['.teamai']);
  });

  it('is idempotent when the agent root already exists', async () => {
    const projectRoot = writeProjectConfig({});
    fs.mkdirSync(path.join(projectRoot, '.claude'));
    await seedProjectAgentRoot('claude', projectRoot);
    expect(fs.existsSync(path.join(projectRoot, '.claude'))).toBe(true);
  });

  it('uses teamai.yaml toolPaths when they override the default root', async () => {
    const projectRoot = writeProjectConfig({
      teamYaml: [
        'team: t',
        'repo: https://example.com/team.git',
        'toolPaths:',
        '  claude:',
        '    skills: .claude-custom/skills',
      ].join('\n'),
    });
    await seedProjectAgentRoot('claude', projectRoot);
    expect(fs.existsSync(path.join(projectRoot, '.claude-custom'))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.claude'))).toBe(false);
  });
});
