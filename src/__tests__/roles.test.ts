import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import {
  describeRoles,
  findRole,
  loadRolesManifest,
  saveRolesManifest,
  resolveRoleResourceNamespaces,
  activeRoleIds,
  loadRolesManifestIfPresent,
  RolesManifestNotFoundError,
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

  /**
   * `push` treats a MISSING manifest as the pre-manifest layout, where a role
   * id doubles as its skills namespace and a new rule or agent stays at the
   * shared root. `readFileSafe` answers null for every failure, so an
   * unreadable manifest arrived looking exactly like a missing one — and sent
   * those resources to the whole team (#649 review).
   */
  // chmod 0o000 has no effect when running as root (CI), so skip — same gate
  // as `src/__tests__/git-kind-learnings.test.ts` (#727).
  it.skipIf(process.getuid?.() === 0)('reports an existing manifest it cannot read, rather than a missing one', async () => {
    const repoDir = writeManifest('version: 1\nroles: []\n');
    const manifestPath = path.join(repoDir, 'manifest', 'roles.yaml');
    chmodSync(manifestPath, 0o000);

    try {
      await expect(loadRolesManifest(repoDir)).rejects.toThrow(/could not be read/);
      await expect(loadRolesManifest(repoDir)).rejects.not.toBeInstanceOf(RolesManifestNotFoundError);
    } finally {
      if (existsSync(manifestPath)) chmodSync(manifestPath, 0o600);
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('reports a genuinely missing manifest as not found', async () => {
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'teamai-roles-'));

    await expect(loadRolesManifest(repoDir)).rejects.toBeInstanceOf(RolesManifestNotFoundError);

    rmSync(repoDir, { recursive: true, force: true });
  });

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

  it('parses an agents resource list and defaults it to empty when absent', async () => {
    const repoDir = writeManifest(`
version: 1
roles:
  - id: frontend
    description: Frontend
    resources:
      knowledge: [common, frontend]
      skills: [common, frontend]
      agents: [common, frontend]
  - id: pm
    description: PM
    resources:
      knowledge: [common, pm]
      skills: [common, pm]
`);

    const manifest = await loadRolesManifest(repoDir);
    expect(manifest.roles[0].resources.agents).toEqual(['common', 'frontend']);
    expect(manifest.roles[1].resources.agents).toEqual([]);

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

  it('fails when a resource namespace is not a safe path segment (traversal guard)', async () => {
    // Role namespaces become directory components (skills/<ns>/, agents/<ns>/)
    // exactly as project namespaces do, so the same boundary guard applies.
    for (const badNamespace of [
      '../../evil', 'a/b', '..', '.', 'x\\y', 'C:evil',
      'a\u0009b', 'a\u007fb', 'a\u0085b',
      '.. ', '.. .', '...', '. ', '  ',
      'frontend.', 'frontend ', 'frontend..',
      'CON', 'nul', 'COM1', 'CON.txt', 'CONIN$', 'CONOUT$.txt',
    ]) {
      const repoDir = writeManifest(`
version: 1
roles:
  - id: hai
    resources:
      knowledge: []
      skills: ['${badNamespace}']
`);

      await expect(loadRolesManifest(repoDir)).rejects.toThrow(/single path segment/i);
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('quotes the offending namespace, so the admin can find the text to fix', async () => {
    const repoDir = writeManifest(`version: 1
roles:
  - id: hai
    resources:
      knowledge: []
      skills: ['../evil']
`);

    try {
      await expect(loadRolesManifest(repoDir)).rejects.toThrow(/; got "\.\.\/evil"/);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('reports an empty manifest as broken rather than missing', async () => {
    // Only ENOENT may become RolesManifestNotFoundError: that is the one case the
    // pull is allowed to treat as "this team has no roles" and stop filtering.
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'teamai-rolesempty-'));
    mkdirSync(path.join(repoDir, 'manifest'), { recursive: true });
    writeFileSync(path.join(repoDir, 'manifest', 'roles.yaml'), '\n');

    await expect(loadRolesManifest(repoDir)).rejects.toThrow(/is empty/i);
    await expect(loadRolesManifest(repoDir)).rejects.not.toBeInstanceOf(RolesManifestNotFoundError);
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('reports an absent manifest with the typed missing error', async () => {
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'teamai-rolesnone-'));
    await expect(loadRolesManifest(repoDir)).rejects.toBeInstanceOf(RolesManifestNotFoundError);
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('names the offending entry instead of dumping a raw ZodError', async () => {
    const repoDir = writeManifest(`
version: 1
roles:
  - id: hai
    resources:
      knowledge: []
      skills: ['a/b']
`);

    await expect(loadRolesManifest(repoDir)).rejects.toThrow(
      /^Invalid roles manifest: roles\.0\.resources\.skills\.0: resource namespace must be a single path segment/,
    );
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

describe('loadRolesManifest rejects namespaces that alias each other by case', () => {
  function writeManifest(content: string): string {
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'teamai-roles-case-'));
    mkdirSync(path.join(repoDir, 'manifest'), { recursive: true });
    writeFileSync(path.join(repoDir, 'manifest', 'roles.yaml'), content, 'utf-8');
    return repoDir;
  }

  it('across roles, for the same resource type', async () => {
    const repoDir = writeManifest(`
version: 1
roles:
  - id: fe
    resources: { knowledge: [], skills: [frontend] }
  - id: fe2
    resources: { knowledge: [], skills: [Frontend] }
`);
    try {
      await expect(loadRolesManifest(repoDir)).rejects.toThrow(
        /Invalid roles manifest: skills namespaces "frontend" \(role fe\) and "Frontend" \(role fe2\) differ only by case/,
      );
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  // Lowercasing alone keeps these apart; the filesystems' case folding does not.
  it.each([
    ['final sigma', 'ας', 'ασ'],
    ['long s', 'ſkills', 'skills'],
  ])('across roles, when only Unicode case folding joins them (%s)', async (_label, first, second) => {
    const repoDir = writeManifest(`
version: 1
roles:
  - id: fe
    resources: { knowledge: [], skills: [${first}] }
  - id: fe2
    resources: { knowledge: [], skills: [${second}] }
`);
    try {
      await expect(loadRolesManifest(repoDir)).rejects.toThrow(
        `Invalid roles manifest: skills namespaces "${first}" (role fe) and "${second}" (role fe2) differ only by case`,
      );
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('but not the same spelling used twice, nor the same name under two resource types', async () => {
    const repoDir = writeManifest(`
version: 1
roles:
  - id: fe
    resources: { knowledge: [frontend], skills: [frontend], agents: [Frontend] }
  - id: fe2
    resources: { knowledge: [frontend], skills: [frontend] }
`);
    try {
      const manifest = await loadRolesManifest(repoDir);
      expect(manifest.roles).toHaveLength(2);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});

describe('loadRolesManifest with a home-relative repo path', () => {
  it("expands '~' the way the helpers it replaced did, instead of reading under cwd", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'teamai-home-'));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const manifestDir = path.join(home, '.teamai', 'team-repo', 'manifest');
      mkdirSync(manifestDir, { recursive: true });
      writeFileSync(path.join(manifestDir, 'roles.yaml'), 'version: 1\nroles:\n  - id: hai\n    resources: { knowledge: [], skills: [common] }\n', 'utf-8');

      const manifest = await loadRolesManifest('~/.teamai/team-repo');
      expect(manifest.roles[0]?.resources.skills).toEqual(['common']);

      // A missing file under `~` is still reported as absent, not as an error.
      await expect(loadRolesManifest('~/.teamai/other-repo')).rejects.toBeInstanceOf(RolesManifestNotFoundError);
    } finally {
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('loadRolesManifestIfPresent', () => {
  it('returns null when the manifest is absent', async () => {
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'teamai-noroles-'));
    try {
      expect(await loadRolesManifestIfPresent(repoDir)).toBeNull();
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  // Root reads a mode-000 file, and Windows has no POSIX mode bits.
  const cannotRevokeRead = process.platform === 'win32' || process.getuid?.() === 0;
  it.skipIf(cannotRevokeRead)('throws when the manifest exists but cannot be read, rather than reporting no roles', async () => {
    const repoDir = mkdtempSync(path.join(os.tmpdir(), 'teamai-roles-eacces-'));
    const manifestPath = path.join(repoDir, 'manifest', 'roles.yaml');
    mkdirSync(path.dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, 'version: 1\nroles:\n  - id: hai\n    resources: { knowledge: [], skills: [] }\n', 'utf-8');
    chmodSync(manifestPath, 0o000);
    try {
      await expect(loadRolesManifestIfPresent(repoDir)).rejects.toThrow(/EACCES|permission denied/i);
    } finally {
      chmodSync(manifestPath, 0o644);
      rmSync(repoDir, { recursive: true, force: true });
    }
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
          agents: [],
        },
      },
      {
        id: 'pm',
        description: 'pm',
        resources: {
          knowledge: ['common', 'pm'],
          skills: ['common', 'pm'],
          agents: [],
        },
      },
      {
        id: 'thpc',
        description: 'thpc',
        resources: {
          knowledge: ['common', 'thpc'],
          skills: ['common', 'thpc'],
          agents: [],
        },
      },
    ],
  };

  it('resolves namespaces for the primary role only', () => {
    expect(resolveRoleResourceNamespaces({ manifest, primaryRole: 'hai', additionalRoles: [] })).toEqual({
      knowledge: ['common', 'hai'],
      skills: ['common', 'hai'],
      learnings: [],
      agents: [],
    });
  });

  it('resolves namespaces for primary and additional roles', () => {
    expect(resolveRoleResourceNamespaces({ manifest, primaryRole: 'hai', additionalRoles: ['pm', 'thpc'] })).toEqual({
      knowledge: ['common', 'hai', 'pm', 'thpc'],
      skills: ['common', 'hai', 'pm', 'thpc'],
      learnings: [],
      agents: [],
    });
  });

  it('deduplicates repeated namespaces across roles', () => {
    expect(resolveRoleResourceNamespaces({ manifest, primaryRole: 'hai', additionalRoles: ['pm', 'hai'] })).toEqual({
      knowledge: ['common', 'hai', 'pm'],
      skills: ['common', 'hai', 'pm'],
      learnings: [],
      agents: [],
    });
  });

  it('rejects unknown saved role ids', () => {
    expect(() => resolveRoleResourceNamespaces({ manifest, primaryRole: 'unknown', additionalRoles: [] })).toThrow(/unknown role/i);
  });

  it('resolves agents namespaces across roles and leaves them empty for roles without agents', () => {
    const withAgents = {
      version: 1,
      roles: [
        { id: 'frontend', description: '', resources: { knowledge: ['common'], skills: ['common'], agents: ['common', 'frontend'] } },
        { id: 'devops', description: '', resources: { knowledge: ['common'], skills: ['common'], agents: ['common', 'devops'] } },
        { id: 'pm', description: '', resources: { knowledge: ['common'], skills: ['common'], agents: [] } },
      ],
    };
    expect(resolveRoleResourceNamespaces({ manifest: withAgents, primaryRole: 'frontend', additionalRoles: ['devops'] }).agents)
      .toEqual(['common', 'frontend', 'devops']);
    expect(resolveRoleResourceNamespaces({ manifest: withAgents, primaryRole: 'pm', additionalRoles: [] }).agents)
      .toEqual([]);
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
        agents: [],
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

describe('activeRoleIds', () => {
  it('returns null when no primary role is configured (legacy member: nothing is filtered)', () => {
    expect(activeRoleIds({ additionalRoles: [] })).toBeNull();
    expect(activeRoleIds({ additionalRoles: ['pm'] })).toBeNull();
  });

  it('returns the primary role followed by additional roles, deduped', () => {
    expect(activeRoleIds({ primaryRole: 'frontend', additionalRoles: ['devops', 'frontend'] }))
      .toEqual(['frontend', 'devops']);
  });
});
