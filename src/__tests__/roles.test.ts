import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  describeRoles,
  loadRolesManifest,
  resolveRoleResourceNamespaces,
} from '../roles.js';

describe('loadRolesManifest', () => {
  function writeManifest(content: string): string {
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'teamai-roles-'));
    const manifestDir = path.join(repoDir, 'manifest');
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(path.join(manifestDir, 'roles.yaml'), content, 'utf-8');
    return repoDir;
  }

  it('parses a valid manifest', async () => {
    const repoDir = writeManifest(`
version: 1
roles:
  - id: hai
    name: HAI R&D
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
      defaults: { shareTarget: 'primary-role' },
      roles: [
        {
          id: 'hai',
          name: 'HAI R&D',
          resources: {
            knowledge: ['common', 'hai'],
            skills: ['common', 'hai'],
            learnings: ['common', 'hai'],
          },
        },
      ],
    });

    rmSync(repoDir, { recursive: true, force: true });
  });

  it('fails when a role is missing resources', async () => {
    const repoDir = writeManifest(`
version: 1
roles:
  - id: hai
    name: HAI R&D
defaults:
  shareTarget: primary-role
`);

    await expect(loadRolesManifest(repoDir)).rejects.toThrow(/resources/i);
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('fails when a role declares an unknown resource type', async () => {
    const repoDir = writeManifest(`
version: 1
roles:
  - id: hai
    name: HAI R&D
    resources:
      knowledge: [common, hai]
      skills: [common, hai]
      learnings: [common, hai]
      docs: [common, hai]
defaults:
  shareTarget: primary-role
`);

    await expect(loadRolesManifest(repoDir)).rejects.toThrow(/unknown resource type/i);
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('fails when duplicate role ids are declared', async () => {
    const repoDir = writeManifest(`
version: 1
roles:
  - id: hai
    name: HAI R&D
    resources:
      knowledge: [common, hai]
      skills: [common, hai]
      learnings: [common, hai]
  - id: hai
    name: Duplicate HAI
    resources:
      knowledge: [common, hai]
      skills: [common, hai]
      learnings: [common, hai]
defaults:
  shareTarget: primary-role
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
        name: 'HAI R&D',
        description: 'hai',
        resources: {
          knowledge: ['common', 'hai'],
          skills: ['common', 'hai'],
          learnings: ['common', 'hai'],
        },
      },
      {
        id: 'pm',
        name: 'PM',
        description: 'pm',
        resources: {
          knowledge: ['common', 'pm'],
          skills: ['common', 'pm'],
          learnings: ['common', 'pm'],
        },
      },
      {
        id: 'thpc',
        name: 'THPC',
        description: 'thpc',
        resources: {
          knowledge: ['common', 'thpc'],
          skills: ['common', 'thpc'],
          learnings: ['common', 'thpc'],
        },
      },
    ],
    defaults: {
      shareTarget: 'primary-role' as const,
    },
  };

  it('resolves namespaces for the primary role only', () => {
    expect(resolveRoleResourceNamespaces({ manifest, primaryRole: 'hai', additionalRoles: [] })).toEqual({
      knowledge: ['common', 'hai'],
      skills: ['common', 'hai'],
      learnings: ['common', 'hai'],
    });
  });

  it('resolves namespaces for primary and additional roles', () => {
    expect(resolveRoleResourceNamespaces({ manifest, primaryRole: 'hai', additionalRoles: ['pm', 'thpc'] })).toEqual({
      knowledge: ['common', 'hai', 'pm', 'thpc'],
      skills: ['common', 'hai', 'pm', 'thpc'],
      learnings: ['common', 'hai', 'pm', 'thpc'],
    });
  });

  it('deduplicates repeated namespaces across roles', () => {
    expect(resolveRoleResourceNamespaces({ manifest, primaryRole: 'hai', additionalRoles: ['pm', 'hai'] })).toEqual({
      knowledge: ['common', 'hai', 'pm'],
      skills: ['common', 'hai', 'pm'],
      learnings: ['common', 'hai', 'pm'],
    });
  });

  it('rejects unknown saved role ids', () => {
    expect(() => resolveRoleResourceNamespaces({ manifest, primaryRole: 'unknown', additionalRoles: [] })).toThrow(/unknown role/i);
  });
});

describe('describeRoles', () => {
  it('formats role labels for prompts and errors', () => {
    expect(describeRoles([
      { id: 'hai', name: 'HAI R&D', description: 'HyperAI research' },
      { id: 'pm', name: 'Product Manager', description: '' },
    ])).toEqual([
      'hai - HAI R&D: HyperAI research',
      'pm - Product Manager',
    ]);
  });
});
