import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

import { buildHandlerRegistry, filterHandlersForConfig } from '../hook-handlers.js';
import type { HookStdin } from '../hook-dispatch.js';
import type { LocalConfig } from '../types.js';

const CODEX_FAMILY = ['codex', 'codex-internal', 'tcodex'];

describe('Codex gets the project\'s rules and instruction blocks from its session-start hook (#938, #945)', () => {
  let tmpDir: string;
  let repoPath: string;
  let localConfig: LocalConfig;

  const registration = (event = 'session-start') =>
    buildHandlerRegistry().find((r) => r.event === event && r.handler.name === 'team-rules');
  const context = async (stdin: HookStdin, tool = 'codex'): Promise<string | null> => {
    const event = stdin.hook_event_name === 'SubagentStart' ? 'subagent-start' : 'session-start';
    const output = await registration(event)!.handler.execute(stdin, tool, localConfig);
    if (output === null) return null;
    const parsed = JSON.parse(output) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    // Codex rejects a hookEventName that is not the event it ran.
    expect(parsed.hookSpecificOutput.hookEventName).toBe(stdin.hook_event_name);
    return parsed.hookSpecificOutput.additionalContext;
  };

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-codex-hook-rules-'));
    // No user scope unless a test writes ~/.teamai/config.yaml.
    vi.stubEnv('HOME', path.join(tmpDir, 'home'));
    repoPath = path.join(tmpDir, 'team-repo');
    await fse.outputFile(path.join(repoPath, 'teamai.yaml'), 'team: test\nrepo: https://example.invalid/x/team.git\n');
    await fse.outputFile(path.join(repoPath, 'rules', 'codeword.md'), 'The team codeword is PELICAN-42.\n');
    await fse.outputFile(path.join(repoPath, 'rules', 'scoped.md'), '---\npaths:\n  - "src/**"\n---\nPrefer named exports.\n');
    localConfig = {
      repo: { localPath: repoPath, remote: 'https://example.invalid/x/team.git' },
      username: 'u',
      additionalRoles: [],
      scope: 'project',
      projectRoot: path.join(tmpDir, 'project'),
    } as unknown as LocalConfig;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  /** A user-scope teamai install whose team repo holds `rules`. */
  async function userScope(rules: Record<string, string>, extra = ''): Promise<void> {
    const userRepo = path.join(tmpDir, 'user-team-repo');
    await fse.outputFile(path.join(userRepo, 'teamai.yaml'), 'team: personal\nrepo: https://example.invalid/x/personal.git\n');
    for (const [name, body] of Object.entries(rules)) await fse.outputFile(path.join(userRepo, 'rules', name), body);
    await fse.outputFile(
      path.join(tmpDir, 'home', '.teamai', 'config.yaml'),
      `repo:\n  localPath: ${userRepo}\n  remote: https://example.invalid/x/personal.git\nusername: u\n${extra}`,
    );
  }

  it.each(CODEX_FAMILY)('adds the team rules for %s at session start, a path-scoped rule after its globs', async (tool) => {
    const text = await context({ hook_event_name: 'SessionStart', source: 'startup' }, tool);

    expect(text).toContain('The team codeword is PELICAN-42.');
    expect(text).toContain('Applies to files matching: src/**\nPrefer named exports.');
    expect(text).not.toContain('paths:');
  });

  it('adds them again after a compaction or a clear, but not on resume, whose history already holds them', async () => {
    for (const source of ['startup', 'clear', 'compact']) {
      expect(await context({ hook_event_name: 'SessionStart', source })).toContain('PELICAN-42');
    }
    expect(await context({ hook_event_name: 'SessionStart', source: 'resume' })).toBeNull();
  });

  it('adds nothing from the user scope, which reaches Codex through its own AGENTS.md', async () => {
    await userScope({ 'personal.md': 'The personal codeword is WREN-5.\n' });

    const text = (await context({ hook_event_name: 'SessionStart', source: 'startup' }))!;

    expect(text).toContain('PELICAN-42');
    expect(text).not.toContain('WREN-5');
  });

  it('adds nothing when the session starts outside a teamai project', async () => {
    localConfig = { ...localConfig, scope: 'user', projectRoot: undefined } as unknown as LocalConfig;

    expect(await context({ hook_event_name: 'SessionStart', source: 'startup' })).toBeNull();
  });

  it('adds the project\'s culture, shared instructions and recall, without their file markers', async () => {
    await fse.outputFile(path.join(repoPath, 'culture.md'), '---\ncompany:\n  name: Acme\n---\n\nBe kind to teammates.\n');
    await fse.outputFile(path.join(repoPath, 'claudemd', 'shared.md'), 'Shared team instructions.\n');
    localConfig = { ...localConfig, recallEnabled: true } as LocalConfig;

    const text = (await context({ hook_event_name: 'SessionStart', source: 'startup' }))!;

    expect(text).toContain('Be kind to teammates.');
    expect(text).toContain('Shared team instructions.');
    expect(text).toContain('Team Knowledge Recall (teamai)');
    expect(text).toContain('PELICAN-42');
    expect(text).not.toContain('<!--');
  });

  it('adds no recall block when recall is off', async () => {
    localConfig = { ...localConfig, recallEnabled: false } as LocalConfig;

    expect(await context({ hook_event_name: 'SessionStart', source: 'startup' })).not.toContain('Team Knowledge Recall');
  });

  it('adds only the shared instructions of the member\'s namespaces', async () => {
    await fse.outputFile(path.join(repoPath, 'manifest', 'projects.yaml'), `
version: 1
projects:
  - id: alpha
    resources: { knowledge: [alpha] }
  - id: billing
    resources: { knowledge: [billing] }
`);
    await fse.outputFile(path.join(repoPath, 'claudemd', 'alpha', 'a.md'), 'Alpha instructions.\n');
    await fse.outputFile(path.join(repoPath, 'claudemd', 'billing', 'b.md'), 'Billing instructions.\n');
    localConfig = { ...localConfig, projects: ['alpha'] } as LocalConfig;

    const text = await context({ hook_event_name: 'SessionStart', source: 'startup' });

    expect(text).toContain('Alpha instructions.');
    expect(text).not.toContain('Billing instructions.');
  });

  it('skips shared instructions still read natively from a retained project AGENTS.md (#945)', async () => {
    await fse.outputFile(path.join(repoPath, 'culture.md'), '---\ncompany:\n  name: Acme\n---\n\nBe kind to teammates.\n');
    await fse.outputFile(path.join(repoPath, 'claudemd', 'shared.md'), 'Shared team instructions.\n');
    await fse.outputFile(
      path.join(tmpDir, 'project', 'AGENTS.md'),
      '# Notes\n\n<!-- [teamai:claudemd:start] -->\nAnother member\'s selection.\n<!-- [teamai:claudemd:end] -->\n',
    );

    const text = (await context({ hook_event_name: 'SessionStart', source: 'startup' }))!;

    expect(text).toContain('Be kind to teammates.');
    expect(text).not.toContain('Shared team instructions.');
    expect(text).not.toContain('Another member');
    expect(text).not.toContain('[teamai:');
    await fse.writeFile(path.join(tmpDir, 'project', 'AGENTS.md'), '# Notes\n');
    expect(await context({ hook_event_name: 'SessionStart', source: 'startup' })).toContain('Shared team instructions.');
  });

  it.each(['# Owners\n', ''])('adds blocks from a shadowed AGENTS.md when AGENTS.override.md contains %j', async (override) => {
    await fse.outputFile(path.join(repoPath, 'culture.md'), '---\ncompany:\n  name: Acme\n---\n\nBe kind to teammates.\n');
    await fse.outputFile(path.join(repoPath, 'claudemd', 'shared.md'), 'Shared team instructions.\n');
    localConfig = { ...localConfig, recallEnabled: true } as LocalConfig;
    const agents = [
      '<!-- [teamai:culture:start] -->', 'Be kind to teammates.', '<!-- [teamai:culture:end] -->',
      '<!-- [teamai:claudemd:start] -->', 'Shared team instructions.', '<!-- [teamai:claudemd:end] -->',
      '<!-- [teamai:recall-rules:start] -->', 'Team Knowledge Recall (teamai)', '<!-- [teamai:recall-rules:end] -->',
    ].join('\n');
    await fse.outputFile(path.join(tmpDir, 'project', 'AGENTS.md'), agents);
    await fse.writeFile(path.join(tmpDir, 'project', 'AGENTS.override.md'), override);

    const text = await context({ hook_event_name: 'SessionStart', source: 'startup' });

    expect(text).toContain('Be kind to teammates.');
    expect(text).toContain('Shared team instructions.');
    expect(text).toContain('Team Knowledge Recall (teamai)');
    expect(await fse.readFile(path.join(tmpDir, 'project', 'AGENTS.md'), 'utf8')).toBe(agents);
    expect(await fse.readFile(path.join(tmpDir, 'project', 'AGENTS.override.md'), 'utf8')).toBe(override);
  });

  it('skips culture still read natively from AGENTS.override.md until cleanup (#945)', async () => {
    await fse.outputFile(path.join(repoPath, 'culture.md'), '---\ncompany:\n  name: Acme\n---\n\nBe kind to teammates.\n');
    await fse.outputFile(path.join(tmpDir, 'project', 'AGENTS.override.md'),
      '<!-- [teamai:culture:start] -->\nAnother member\'s culture.\n<!-- [teamai:culture:end] -->\n');

    const text = await context({ hook_event_name: 'SessionStart', source: 'startup' });

    expect(text).not.toContain('Be kind to teammates.');
    expect(text).not.toContain('Another member');
    await fse.writeFile(path.join(tmpDir, 'project', 'AGENTS.override.md'), '# Notes\n');
    expect(await context({ hook_event_name: 'SessionStart', source: 'startup' })).toContain('Be kind to teammates.');
  });

  it('adds no rules from a scope that does not enable the tool', async () => {
    await userScope({ 'personal.md': 'The personal codeword is WREN-5.\n' }, 'enabledAgents: [claude]\n');
    localConfig = { ...localConfig, enabledAgents: ['claude'] } as LocalConfig;

    expect(await context({ hook_event_name: 'SessionStart', source: 'startup' })).toBeNull();
  });

  it('adds them to a subagent Codex starts, as SubagentStart', async () => {
    expect(await context({ hook_event_name: 'SubagentStart', agent_type: 'worker' })).toContain('PELICAN-42');
    expect(registration('subagent-start')).toMatchObject({ matcher: '*', requiresConfig: true });
    expect(registration('subagent-start')?.background).not.toBe(true);
  });

  it('adds nothing for a tool that reads its own rules directory', async () => {
    expect(await context({ hook_event_name: 'SessionStart', source: 'startup' }, 'claude')).toBeNull();
  });

  it('adds only the rules of the member\'s projects', async () => {
    await fse.outputFile(path.join(repoPath, 'manifest', 'projects.yaml'), `
version: 1
projects:
  - id: alpha
    resources: { knowledge: [alpha] }
  - id: billing
    resources: { knowledge: [billing] }
`);
    await fse.outputFile(path.join(repoPath, 'rules', 'alpha', 'alpha-rule.md'), 'Alpha rule.\n');
    await fse.outputFile(path.join(repoPath, 'rules', 'billing', 'billing-rule.md'), 'Billing rule.\n');
    localConfig = { ...localConfig, projects: ['alpha'] } as LocalConfig;

    const text = await context({ hook_event_name: 'SessionStart', source: 'startup' });

    expect(text).toContain('Alpha rule.');
    expect(text).not.toContain('Billing rule.');
  });

  it('adds nothing when no rule has a body', async () => {
    await fse.remove(path.join(repoPath, 'rules'));
    await fse.outputFile(path.join(repoPath, 'rules', 'empty.md'), '---\npaths:\n  - "src/**"\n---\n');

    expect(await context({ hook_event_name: 'SessionStart', source: 'startup' })).toBeNull();
  });

  it('runs in the foreground at session start, only where teamai is set up', () => {
    expect(registration()).toMatchObject({ event: 'session-start', matcher: '*', requiresConfig: true });
    expect(registration()?.background).not.toBe(true);
    expect(filterHandlersForConfig(buildHandlerRegistry(), null).map((r) => r.handler.name)).not.toContain('team-rules');
  });
});
