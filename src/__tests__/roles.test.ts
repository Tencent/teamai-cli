import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import {
  describeRoles,
  findRole,
  loadRolesManifest,
  saveRolesManifest,
  resolveRoleResourceNamespaces,
} from '../roles.js';
import type { RolesManifest } from '../roles.js';

describe('loadRolesManifest', () => {
  function writeManifest(content: string): string {
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'teamai-roles-'));
    const manifestDir = path.join(repoDir, 'manifest');
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(path.join(manifestDir, 'roles.yaml'), content, 'utf-8');
    return repoDir;
  }

  it('parses a valid manifest (with legacy learnings + shareTarget)', async () => {
    // Old manifests with learnings and shareTarget should still parse without error
    const repoDir = writeManifest(`
version: 1
roles:
  - id: hai
    description: HyperAI research and development resources
    resources:
      knowledge: [common, hai]
      skills: [common, hai]
      learnings: [common, hai]
defaults:
  shareTarget: primary-role
`);

    await expect(loadRolesManifest(repoDir)).resolves.toMatchObject({
      version: 1,
      roles: [
        {
          id: 'hai',
          resources: {
            knowledge: ['common', 'hai'],
            skills: ['common', 'hai'],
          },
        },
      ],
    });

    rmSync(repoDir, { recursive: true, force: true });
  });

  it('parses a manifest without learnings or defaults', async () => {
    const repoDir = writeManifest(`
version: 1
roles:
  - id: hai
    description: HyperAI
    resources:
      knowledge: [common, hai]
      skills: [common, hai]
`);

    const result = await loadRolesManifest(repoDir);
    expect(result.version).toBe(1);
    expect(result.roles[0].resources.skills).toEqual(['common', 'hai']);
    expect(result.roles[0].resources.learnings).toBeUndefined();

    rmSync(repoDir, { recursive: true, force: true });
  });

  it('fails when a role is missing resources', async () => {
    const repoDir = writeManifest(`
version: 1
roles:
  - id: hai
`);

    await expect(loadRolesManifest(repoDir)).rejects.toThrow(/resources/i);
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('fails when a role declares an unknown resource type', async () => {
    const repoDir = writeManifest(`
version: 1
roles:
  - id: hai
    resources:
      knowledge: [common, hai]
      skills: [common, hai]
      docs: [common, hai]
`);

    await expect(loadRolesManifest(repoDir)).rejects.toThrow(/unknown resource type/i);
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('fails when duplicate role ids are declared', async () => {
    const repoDir = writeManifest(`
version: 1
roles:
  - id: hai
    resources:
      knowledge: [common, hai]
      skills: [common, hai]
  - id: hai
    resources:
      knowledge: [common, hai]
      skills: [common, hai]
`);

    await expect(loadRolesManifest(repoDir)).rejects.toThrow(/duplicate role id/i);
    rmSync(repoDir, { recursive: true, force: true });
  });
});

describe('resolveRoleResourceNamespaces', () => {
  const manifest = {
    version: 1,
    roles: [
      {
        id: 'hai',
        description: 'hai',
        resources: {
          knowledge: ['common', 'hai'],
          skills: ['common', 'hai'],
        },
      },
      {
        id: 'pm',
        description: 'pm',
        resources: {
          knowledge: ['common', 'pm'],
          skills: ['common', 'pm'],
        },
      },
      {
        id: 'thpc',
        description: 'thpc',
        resources: {
          knowledge: ['common', 'thpc'],
          skills: ['common', 'thpc'],
        },
      },
    ],
  };

  it('resolves namespaces for the primary role only', () => {
    expect(resolveRoleResourceNamespaces({ manifest, primaryRole: 'hai', additionalRoles: [] })).toEqual({
      knowledge: ['common', 'hai'],
      skills: ['common', 'hai'],
    });
  });

  it('resolves namespaces for primary and additional roles', () => {
    expect(resolveRoleResourceNamespaces({ manifest, primaryRole: 'hai', additionalRoles: ['pm', 'thpc'] })).toEqual({
      knowledge: ['common', 'hai', 'pm', 'thpc'],
      skills: ['common', 'hai', 'pm', 'thpc'],
    });
  });

  it('deduplicates repeated namespaces across roles', () => {
    expect(resolveRoleResourceNamespaces({ manifest, primaryRole: 'hai', additionalRoles: ['pm', 'hai'] })).toEqual({
      knowledge: ['common', 'hai', 'pm'],
      skills: ['common', 'hai', 'pm'],
    });
  });

  it('rejects unknown saved role ids', () => {
    expect(() => resolveRoleResourceNamespaces({ manifest, primaryRole: 'unknown', additionalRoles: [] })).toThrow(/unknown role/i);
  });
});

describe('describeRoles', () => {
  it('formats role labels for prompts and errors', () => {
    expect(describeRoles([
      { id: 'hai', description: 'HyperAI research' },
      { id: 'pm', description: '' },
    ])).toEqual([
      'hai: HyperAI research',
      'pm',
    ]);
  });
});

// ─── New tests for saveRolesManifest and findRole ─────────

function makeManifest(roles: Array<{ id: string; namespaces: string[] }>): RolesManifest {
  return {
    version: 1,
    roles: roles.map((r) => ({
      id: r.id,
      description: '',
      resources: {
        knowledge: r.namespaces,
        skills: r.namespaces,
      },
    })),
  };
}

describe('saveRolesManifest', () => {
  it('writes a valid manifest and can be loaded back', async () => {
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'teamai-roles-save-'));
    const manifest = makeManifest([{ id: 'hai', namespaces: ['common', 'hai'] }]);

    await saveRolesManifest(repoDir, manifest);

    const loaded = await loadRolesManifest(repoDir);
    expect(loaded.roles[0].id).toBe('hai');
    expect(loaded.roles[0].resources.skills).toEqual(['common', 'hai']);

    rmSync(repoDir, { recursive: true, force: true });
  });

  it('creates the manifest directory if it does not exist', async () => {
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'teamai-roles-save-'));
    const manifestPath = path.join(repoDir, 'manifest', 'roles.yaml');
    expect(existsSync(manifestPath)).toBe(false);

    const manifest = makeManifest([{ id: 'test', namespaces: ['common'] }]);
    await saveRolesManifest(repoDir, manifest);

    expect(existsSync(manifestPath)).toBe(true);

    rmSync(repoDir, { recursive: true, force: true });
  });

  it('rejects an invalid manifest (empty roles array)', async () => {
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'teamai-roles-save-'));
    const badManifest = { version: 1, roles: [] };

    await expect(saveRolesManifest(repoDir, badManifest as RolesManifest)).rejects.toThrow();

    rmSync(repoDir, { recursive: true, force: true });
  });

  it('rejects a manifest with duplicate role ids', async () => {
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'teamai-roles-save-'));
    const manifest = makeManifest([
      { id: 'hai', namespaces: ['common'] },
      { id: 'hai', namespaces: ['common'] },
    ]);

    await expect(saveRolesManifest(repoDir, manifest)).rejects.toThrow(/duplicate role id/i);

    rmSync(repoDir, { recursive: true, force: true });
  });
});

describe('findRole', () => {
  const manifest = makeManifest([
    { id: 'hai', namespaces: ['common', 'hai'] },
    { id: 'pm', namespaces: ['common', 'pm'] },
  ]);

  it('returns the role when it exists', () => {
    const role = findRole(manifest, 'hai');
    expect(role).toBeDefined();
    expect(role!.id).toBe('hai');
  });

  it('returns undefined when role does not exist', () => {
    const role = findRole(manifest, 'nonexistent');
    expect(role).toBeUndefined();
  });
});
