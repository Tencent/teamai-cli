import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadTeamConfig } from '../config.js';
import { toolPathsDroppedKeyNotes } from '../doctor-delivery.js';
import { resetToolInstancesForTests } from '../tool-instances.js';
import type { DoctorContext } from '../doctor.js';
import { TeamaiConfigSchema, scopedToolPaths, type LocalConfig, type TeamaiConfig } from '../types.js';

/**
 * #1115's dropped-key half: a team `toolPaths` entry replaces that tool's
 * default whole, so an entry that names a tool but omits a key the default
 * provides silently disables the surface behind it — hooks skip the tool, no
 * skills arrive — and nothing surfaces the drop. One note per affected tool:
 * surfaced in the doctor report, never failing (omission is a valid opt-out).
 */
describe('doctor notes — toolPaths entries that drop a default-provided key (#1115)', () => {
  const ctxWith = (toolPaths: Record<string, unknown>): DoctorContext => {
    const teamConfig = TeamaiConfigSchema.parse({ team: 't', repo: 'owner/repo', toolPaths }) as TeamaiConfig;
    const localConfig = {} as LocalConfig;
    return { localConfig, teamConfig, toolPaths: teamConfig.toolPaths, hookToolPaths: teamConfig.toolPaths, baseDir: '/tmp' } as DoctorContext;
  };

  it('names the settings a zcode entry drops, with the replace-whole reason and the exact key', () => {
    // The shape from #1115's verification: skills and rules customized,
    // settings omitted — hooks then report `no settings configured`.
    const notes = toolPathsDroppedKeyNotes(ctxWith({
      zcode: { skills: '.zcode/skills', rules: '.zcode/rules' },
    }));
    const note = notes.find((line) => line.includes('zcode'));
    expect(note).toBeDefined();
    expect(note).toContain("replaces the tool's default entry whole");
    expect(note).toContain('`settings`');
    expect(note).toContain('.zcode/cli/config.json');
    expect(note).toContain('hook reconciliation silently skips');
    expect(note).toContain('leave it out on purpose');
  });

  it('does not name keys the default itself does not provide (codex has no rules)', () => {
    const notes = toolPathsDroppedKeyNotes(ctxWith({
      codex: { skills: '.codex/skills', settings: '.codex/hooks.json' },
    }));
    expect(notes.some((line) => line.includes('`rules`'))).toBe(false);
  });

  it('names only dropped keys, not the ones the entry keeps', () => {
    const notes = toolPathsDroppedKeyNotes(ctxWith({
      zcode: { skills: '.zcode/skills', rules: '.zcode/rules' },
    }));
    const note = notes.find((line) => line.includes('zcode')) ?? '';
    expect(note).not.toContain('`skills`');
    expect(note).not.toContain('`rules`');
  });

  it('ignores a custom tool no default table entry covers', () => {
    expect(toolPathsDroppedKeyNotes(ctxWith({
      'my-private-agent': { skills: '.my-agent/skills' },
    }))).toHaveLength(0);
  });

  it('reports nothing for an entry that restates every default-provided key', () => {
    expect(toolPathsDroppedKeyNotes(ctxWith({
      zcode: {
        skills: '.zcode/skills',
        agents: '.zcode/agents',
        settings: '.zcode/cli/config.json',
        mcp: '.zcode/cli/config.json',
        mcpProject: '.zcode/config.json',
      },
    }))).toHaveLength(0);
  });

  it('reports nothing for a user-scope member whose team never names toolPaths', () => {
    // resolveDoctorContext hands the checks scopedToolPaths output: joycode's
    // user scope drops `rules` on purpose (#946), and the team named no tool.
    const teamConfig = TeamaiConfigSchema.parse({ team: 't', repo: 'owner/repo' }) as TeamaiConfig;
    const toolPaths = scopedToolPaths(teamConfig, { scope: 'user' });
    expect(toolPaths.joycode?.rules).toBeUndefined();
    const ctx = { localConfig: {} as LocalConfig, teamConfig, toolPaths, hookToolPaths: toolPaths, baseDir: '/tmp' } as DoctorContext;
    expect(toolPathsDroppedKeyNotes(ctx)).toEqual([]);
  });

  it('returns nothing without a team config', () => {
    const ctx = { localConfig: {} as LocalConfig, teamConfig: null, toolPaths: {}, hookToolPaths: {}, baseDir: '/tmp' } as unknown as DoctorContext;
    expect(toolPathsDroppedKeyNotes(ctx)).toHaveLength(0);
  });
});

describe('doctor notes — a team tool instance whose paths drop a key', () => {
  afterEach(resetToolInstancesForTests);

  const contextOf = async (files: Record<string, string>): Promise<DoctorContext> => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-instance-doctor-'));
    fs.writeFileSync(path.join(repo, 'teamai.yaml'), 'team: t\nrepo: owner/repo\n');

    for (const [file, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      fs.writeFileSync(path.join(repo, file), text);
    }

    const teamConfig = await loadTeamConfig(repo);
    fs.rmSync(repo, { recursive: true, force: true });
    if (!teamConfig) throw new Error('teamai.yaml did not load');
    return { localConfig: {} as LocalConfig, teamConfig, toolPaths: teamConfig.toolPaths, hookToolPaths: teamConfig.toolPaths, baseDir: '/tmp' } as DoctorContext;
  };

  it('names the instance file and each key its paths drop from the tool it adjusts', async () => {
    const notes = toolPathsDroppedKeyNotes(await contextOf({ 'tools/claude.yaml': 'schemaVersion: v1alpha1\nname: claude\nextends: claude\npaths: { skills: .claude/team-skills, rules: .claude/rules }\n' }));
    const note = notes.find((line) => line.includes('claude')) ?? '';

    expect(note).toMatch(/^paths in tools\/claude\.yaml replaces claude's default entry whole and drops keys the default provides: /);
    expect(note).toContain('`settings` (.claude/settings.json — hook reconciliation silently skips the tool)');
    expect(note).not.toContain('`skills`');
  });

  it('names the keys an instance of another name drops from the paths of the tool it extends, moved to its home', async () => {
    const notes = toolPathsDroppedKeyNotes(await contextOf({ 'tools/acme-claude.yaml': 'schemaVersion: v1alpha1\nname: acme-claude\nextends: claude\ncommand: acme-claude\nhome: { dir: .acme-claude }\npaths: { skills: .acme-claude/skills }\n' }));

    expect(notes).toEqual([expect.stringMatching(/^paths in tools\/acme-claude\.yaml replaces acme-claude's default entry whole .*`agents` \(\.acme-claude\/agents — no agents are delivered to it\)/)]);
  });

  it('names no key the paths it would get without its own lack, under a team that adjusted the tool it extends', async () => {
    const notes = toolPathsDroppedKeyNotes(await contextOf({
      'tools/codex.yaml': 'schemaVersion: v1alpha1\nname: codex\nextends: codex\npaths: { skills: .codex/team-skills, settings: .codex/hooks.json }\n',
      'tools/beta-codex.yaml': 'schemaVersion: v1alpha1\nname: beta-codex\nextends: codex\nhome: { dir: .beta-codex }\npaths: { skills: .beta-codex/skills }\n',
    }));

    expect(notes.join('\n')).not.toContain('undefined');
  });

  it('measures an instance\'s paths against the team\'s paths of the tool it extends, which it would get without them', async () => {
    const notes = toolPathsDroppedKeyNotes(await contextOf({
      'teamai.yaml': 'team: t\nrepo: owner/repo\ntoolPaths:\n  claude: { skills: .claude/skills, settings: .claude/settings.json }\n',
      'tools/acme-claude.yaml': 'schemaVersion: v1alpha1\nname: acme-claude\nextends: claude\ncommand: acme-claude\nhome: { dir: .acme-claude }\npaths: { skills: .acme-claude/skills, settings: .acme-claude/settings.json }\n',
    }));

    expect(notes.filter((line) => line.startsWith('paths in tools/acme-claude.yaml'))).toEqual([]);
  });
});
