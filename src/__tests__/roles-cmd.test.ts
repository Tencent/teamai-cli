import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

// We test the pure logic functions from roles-cmd.ts by importing them.
// For interactive commands (rolesInit), we test the underlying roles.ts functions
// and the manifest generation logic.

import {
  loadRolesManifest,
  saveRolesManifest,
  findRole,
  listRoleIds,
  describeRoles,
  resolveRoleResourceNamespaces,
} from '../roles.js';
import type { RolesManifest, TeamRole } from '../roles.js';

function createTempRepo(options?: { withManifest?: boolean; roles?: Array<{ id: string; namespaces: string[] }> }): string {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'teamai-roles-cmd-'));

  if (options?.withManifest) {
    const roles = options.roles ?? [
      { id: 'hai', namespaces: ['common', 'hai'] },
      { id: 'pm', namespaces: ['common', 'pm'] },
    ];

    const manifest = {
      version: 1,
      roles: roles.map((r) => ({
        id: r.id,
        description: '',
        resources: {
          knowledge: r.namespaces,
          skills: r.namespaces,
          learnings: r.namespaces,
        },
      })),
      defaults: { shareTarget: 'primary-role' },
    };

    const manifestDir = path.join(repoDir, 'manifest');
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(path.join(manifestDir, 'roles.yaml'), YAML.stringify(manifest), 'utf-8');
  }

  return repoDir;
}

describe('roles list — manifest loading', () => {
  it('loads manifest and lists role ids', async () => {
    const repoDir = createTempRepo({ withManifest: true });

    const manifest = await loadRolesManifest(repoDir);
    const ids = listRoleIds(manifest);

    expect(ids).toEqual(['hai', 'pm']);

    rmSync(repoDir, { recursive: true, force: true });
  });

  it('returns descriptive labels for roles', async () => {
    const repoDir = createTempRepo({
      withManifest: true,
      roles: [
        { id: 'devops', namespaces: ['common', 'infra'] },
      ],
    });

    const manifest = await loadRolesManifest(repoDir);
    const labels = describeRoles(manifest.roles);

    expect(labels).toEqual(['devops']);

    rmSync(repoDir, { recursive: true, force: true });
  });

  it('throws when manifest is missing', async () => {
    const repoDir = createTempRepo({ withManifest: false });

    await expect(loadRolesManifest(repoDir)).rejects.toThrow(/Roles manifest not found/);

    rmSync(repoDir, { recursive: true, force: true });
  });
});

describe('roles set — validation', () => {
  it('resolves namespaces for a valid primary role', async () => {
    const repoDir = createTempRepo({ withManifest: true });
    const manifest = await loadRolesManifest(repoDir);

    const result = resolveRoleResourceNamespaces({
      manifest,
      primaryRole: 'hai',
      additionalRoles: [],
    });

    expect(result.skills).toEqual(['common', 'hai']);
    expect(result.knowledge).toEqual(['common', 'hai']);

    rmSync(repoDir, { recursive: true, force: true });
  });

  it('resolves namespaces for primary + additional roles', async () => {
    const repoDir = createTempRepo({ withManifest: true });
    const manifest = await loadRolesManifest(repoDir);

    const result = resolveRoleResourceNamespaces({
      manifest,
      primaryRole: 'hai',
      additionalRoles: ['pm'],
    });

    expect(result.skills).toEqual(['common', 'hai', 'pm']);

    rmSync(repoDir, { recursive: true, force: true });
  });

  it('rejects unknown primary role', async () => {
    const repoDir = createTempRepo({ withManifest: true });
    const manifest = await loadRolesManifest(repoDir);

    expect(() =>
      resolveRoleResourceNamespaces({
        manifest,
        primaryRole: 'nonexistent',
        additionalRoles: [],
      }),
    ).toThrow(/Unknown role "nonexistent"/);

    rmSync(repoDir, { recursive: true, force: true });
  });

  it('rejects unknown additional role', async () => {
    const repoDir = createTempRepo({ withManifest: true });
    const manifest = await loadRolesManifest(repoDir);

    expect(() =>
      resolveRoleResourceNamespaces({
        manifest,
        primaryRole: 'hai',
        additionalRoles: ['unknown'],
      }),
    ).toThrow(/Unknown role "unknown"/);

    rmSync(repoDir, { recursive: true, force: true });
  });
});

describe('roles init — manifest generation', () => {
  it('generates valid YAML from role definitions', () => {
    const roles = [
      {
        id: 'hai',
        description: 'HyperAI research',
        resources: {
          knowledge: ['common', 'hai'],
          skills: ['common', 'hai'],
          learnings: ['common', 'hai'],
        },
      },
      {
        id: 'tencent',
        description: 'Internal platform tools',
        resources: {
          knowledge: ['common', 'tencent'],
          skills: ['common', 'tencent'],
          learnings: ['common', 'tencent'],
        },
      },
    ];

    const manifest = {
      version: 1,
      roles,
      defaults: { shareTarget: 'primary-role' },
    };

    const yamlContent = YAML.stringify(manifest);
    const parsed = YAML.parse(yamlContent);

    expect(parsed.version).toBe(1);
    expect(parsed.roles).toHaveLength(2);
    expect(parsed.roles[0].id).toBe('hai');
    expect(parsed.roles[0].resources.skills).toEqual(['common', 'hai']);
    expect(parsed.roles[1].id).toBe('tencent');
    expect(parsed.defaults.shareTarget).toBe('primary-role');
  });

  it('writes manifest to correct path with ensureDir', async () => {
    const repoDir = createTempRepo({ withManifest: false });
    const manifestDir = path.join(repoDir, 'manifest');
    const manifestPath = path.join(manifestDir, 'roles.yaml');

    // Simulate what rolesInit does
    mkdirSync(manifestDir, { recursive: true });
    const content = YAML.stringify({
      version: 1,
      roles: [{ id: 'test', description: '', resources: { knowledge: ['common'], skills: ['common'], learnings: ['common'] } }],
      defaults: { shareTarget: 'primary-role' },
    });
    writeFileSync(manifestPath, content, 'utf-8');

    expect(existsSync(manifestPath)).toBe(true);

    // Verify it can be loaded back
    const manifest = await loadRolesManifest(repoDir);
    expect(manifest.roles[0].id).toBe('test');

    rmSync(repoDir, { recursive: true, force: true });
  });

  it('detects existing manifest for overwrite guard', async () => {
    const repoDir = createTempRepo({ withManifest: true });
    const manifestPath = path.join(repoDir, 'manifest', 'roles.yaml');

    expect(existsSync(manifestPath)).toBe(true);

    rmSync(repoDir, { recursive: true, force: true });
  });
});

describe('init.ts — missing manifest graceful skip', () => {
  it('loadRolesManifest throws with specific message when manifest missing', async () => {
    const repoDir = createTempRepo({ withManifest: false });

    await expect(loadRolesManifest(repoDir)).rejects.toThrow('Roles manifest not found');

    rmSync(repoDir, { recursive: true, force: true });
  });

  it('error message includes path for debugging', async () => {
    const repoDir = createTempRepo({ withManifest: false });

    try {
      await loadRolesManifest(repoDir);
    } catch (e) {
      expect((e as Error).message).toContain('manifest/roles.yaml');
    }

    rmSync(repoDir, { recursive: true, force: true });
  });
});

// ─── roles add — manifest manipulation logic ────────────

describe('roles add — manifest manipulation', () => {
  it('adds a new role to existing manifest', async () => {
    const repoDir = createTempRepo({ withManifest: true });
    const manifest = await loadRolesManifest(repoDir);

    const newRole: TeamRole = {
      id: 'devops',
      description: 'Infrastructure team',
      resources: {
        knowledge: ['common', 'infra'],
        skills: ['common', 'infra'],
        learnings: ['common', 'infra'],
      },
    };

    const updated: RolesManifest = {
      ...manifest,
      roles: [...manifest.roles, newRole],
    };

    await saveRolesManifest(repoDir, updated);
    const reloaded = await loadRolesManifest(repoDir);

    expect(reloaded.roles).toHaveLength(3);
    expect(reloaded.roles[2].id).toBe('devops');
    expect(reloaded.roles[2].description).toBe('Infrastructure team');
    expect(reloaded.roles[2].resources.skills).toEqual(['common', 'infra']);

    rmSync(repoDir, { recursive: true, force: true });
  });

  it('rejects adding a role with duplicate id', async () => {
    const repoDir = createTempRepo({ withManifest: true });
    const manifest = await loadRolesManifest(repoDir);

    expect(findRole(manifest, 'hai')).toBeDefined();

    // Attempting to save with duplicate id should fail validation
    const duplicate: TeamRole = {
      id: 'hai',
      description: 'duplicate',
      resources: { knowledge: ['x'], skills: ['x'], learnings: ['x'] },
    };
    const bad: RolesManifest = { ...manifest, roles: [...manifest.roles, duplicate] };

    await expect(saveRolesManifest(repoDir, bad)).rejects.toThrow(/duplicate role id/i);

    rmSync(repoDir, { recursive: true, force: true });
  });

  it('findRole returns undefined for non-existent id', async () => {
    const repoDir = createTempRepo({ withManifest: true });
    const manifest = await loadRolesManifest(repoDir);

    expect(findRole(manifest, 'nonexistent')).toBeUndefined();

    rmSync(repoDir, { recursive: true, force: true });
  });
});

// ─── roles remove — manifest manipulation logic ─────────

describe('roles remove — manifest manipulation', () => {
  it('removes an existing role from manifest', async () => {
    const repoDir = createTempRepo({ withManifest: true });
    const manifest = await loadRolesManifest(repoDir);

    expect(listRoleIds(manifest)).toContain('hai');

    const updated: RolesManifest = {
      ...manifest,
      roles: manifest.roles.filter((r) => r.id !== 'hai'),
    };

    await saveRolesManifest(repoDir, updated);
    const reloaded = await loadRolesManifest(repoDir);

    expect(listRoleIds(reloaded)).not.toContain('hai');
    expect(reloaded.roles).toHaveLength(1);
    expect(reloaded.roles[0].id).toBe('pm');

    rmSync(repoDir, { recursive: true, force: true });
  });

  it('rejects removing the last role (empty roles array)', async () => {
    const repoDir = createTempRepo({
      withManifest: true,
      roles: [{ id: 'only', namespaces: ['common'] }],
    });
    const manifest = await loadRolesManifest(repoDir);

    const empty: RolesManifest = { ...manifest, roles: [] };

    await expect(saveRolesManifest(repoDir, empty as RolesManifest)).rejects.toThrow();

    rmSync(repoDir, { recursive: true, force: true });
  });

  it('findRole returns undefined for removed role', async () => {
    const repoDir = createTempRepo({ withManifest: true });
    const manifest = await loadRolesManifest(repoDir);

    const updated: RolesManifest = {
      ...manifest,
      roles: manifest.roles.filter((r) => r.id !== 'hai'),
    };

    expect(findRole(updated, 'hai')).toBeUndefined();
    expect(findRole(updated, 'pm')).toBeDefined();

    rmSync(repoDir, { recursive: true, force: true });
  });
});

// ─── roles update — manifest manipulation logic ─────────

describe('roles update — manifest manipulation', () => {
  it('adds namespaces to an existing role', async () => {
    const repoDir = createTempRepo({ withManifest: true });
    const manifest = await loadRolesManifest(repoDir);

    const role = findRole(manifest, 'hai')!;
    const existingNs = new Set(role.resources.skills);
    existingNs.add('infra');
    const updatedNs = [...existingNs];

    const updatedRole: TeamRole = {
      ...role,
      resources: { knowledge: updatedNs, skills: updatedNs, learnings: updatedNs },
    };

    const updated: RolesManifest = {
      ...manifest,
      roles: manifest.roles.map((r) => (r.id === 'hai' ? updatedRole : r)),
    };

    await saveRolesManifest(repoDir, updated);
    const reloaded = await loadRolesManifest(repoDir);

    expect(findRole(reloaded, 'hai')!.resources.skills).toEqual(['common', 'hai', 'infra']);

    rmSync(repoDir, { recursive: true, force: true });
  });

  it('removes namespaces from an existing role', async () => {
    const repoDir = createTempRepo({
      withManifest: true,
      roles: [{ id: 'hai', namespaces: ['common', 'hai', 'extra'] }],
    });
    const manifest = await loadRolesManifest(repoDir);

    const role = findRole(manifest, 'hai')!;
    const toRemove = new Set(['extra']);
    const remaining = role.resources.skills.filter((ns) => !toRemove.has(ns));

    const updatedRole: TeamRole = {
      ...role,
      resources: { knowledge: remaining, skills: remaining, learnings: remaining },
    };

    const updated: RolesManifest = {
      ...manifest,
      roles: manifest.roles.map((r) => (r.id === 'hai' ? updatedRole : r)),
    };

    await saveRolesManifest(repoDir, updated);
    const reloaded = await loadRolesManifest(repoDir);

    expect(findRole(reloaded, 'hai')!.resources.skills).toEqual(['common', 'hai']);

    rmSync(repoDir, { recursive: true, force: true });
  });

  it('updates description of an existing role', async () => {
    const repoDir = createTempRepo({ withManifest: true });
    const manifest = await loadRolesManifest(repoDir);

    const role = findRole(manifest, 'hai')!;
    const updatedRole: TeamRole = { ...role, description: 'HyperAI research team' };

    const updated: RolesManifest = {
      ...manifest,
      roles: manifest.roles.map((r) => (r.id === 'hai' ? updatedRole : r)),
    };

    await saveRolesManifest(repoDir, updated);
    const reloaded = await loadRolesManifest(repoDir);

    expect(findRole(reloaded, 'hai')!.description).toBe('HyperAI research team');

    rmSync(repoDir, { recursive: true, force: true });
  });

  it('allows empty namespaces at schema level (command layer guards this)', async () => {
    const repoDir = createTempRepo({ withManifest: true });
    const manifest = await loadRolesManifest(repoDir);

    const role = findRole(manifest, 'hai')!;
    const updatedRole: TeamRole = {
      ...role,
      resources: { knowledge: [], skills: [], learnings: [] },
    };

    const updated: RolesManifest = {
      ...manifest,
      roles: manifest.roles.map((r) => (r.id === 'hai' ? updatedRole : r)),
    };

    // Schema allows empty arrays; the command layer (rolesUpdate) guards against this
    await saveRolesManifest(repoDir, updated);
    const reloaded = await loadRolesManifest(repoDir);
    expect(findRole(reloaded, 'hai')!.resources.skills).toEqual([]);

    rmSync(repoDir, { recursive: true, force: true });
  });

  it('deduplicates when adding namespaces that already exist', () => {
    const existing = ['common', 'hai'];
    const toAdd = ['hai', 'infra'];
    const ns = new Set(existing);
    for (const a of toAdd) ns.add(a);
    expect([...ns]).toEqual(['common', 'hai', 'infra']);
  });
});
