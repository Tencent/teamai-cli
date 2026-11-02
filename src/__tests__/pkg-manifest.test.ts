import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadTeamConfig } from '../config.js';
import {
  loadPackageLock,
  loadPackageManifest,
  packageDeclarationHash,
  savePackageLock,
  savePackageManifest,
} from '../pkg/manifest.js';
import { NpmSpecSchema } from '../pkg/types.js';

describe('package manifest and lockfile', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-pkg-manifest-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('loads npm and Claude declarations from the team config', async () => {
    fs.writeFileSync(path.join(dir, 'teamai.yaml'), YAML.stringify({
      team: 'platform',
      repo: 'acme/team',
      packages: {
        npm: [{ name: 'typescript', version: '^5.9.0' }],
        claude: {
          marketplaces: [{ name: 'official', repo: 'acme/plugins' }],
          plugins: [{ name: 'review@official' }],
        },
      },
    }));

    const manifest = await loadPackageManifest(dir);
    expect(manifest.name).toBe('platform');
    expect(manifest.packages.npm).toEqual([{ name: 'typescript', version: '^5.9.0' }]);
    expect(manifest.packages.claude?.plugins[0].name).toBe('review@official');
  });

  it('saves teamai.yaml with its other keys as written, a .inf and a __proto__ key included', async () => {
    fs.writeFileSync(path.join(dir, 'teamai.yaml'), [
      'team: platform',
      'limits:',
      '  budget: .inf',
      '  __proto__: kept',
      'packages:',
      '  npm: []',
      '',
    ].join('\n'));

    const manifest = await loadPackageManifest(dir);
    await savePackageManifest(dir, { ...manifest, packages: { npm: [{ name: 'typescript', version: '^5.9.0' }] } });

    expect(fs.readFileSync(path.join(dir, 'teamai.yaml'), 'utf8')).toBe([
      'team: platform',
      'limits:',
      '  budget: .inf',
      '  __proto__: kept',
      'packages:',
      '  npm:',
      '    - name: typescript',
      '      version: ^5.9.0',
      '',
    ].join('\n'));
  });

  it('rejects undeclared plugin marketplaces', async () => {
    fs.writeFileSync(path.join(dir, 'teamai.yaml'), YAML.stringify({
      packages: {
        claude: {
          marketplaces: [],
          plugins: [{ name: 'review@missing' }],
        },
      },
    }));
    await expect(loadPackageManifest(dir)).rejects.toThrow('not declared');
  });

  it('parses global npm tools and rejects registry URLs with credentials', async () => {
    fs.writeFileSync(path.join(dir, 'teamai.yaml'), YAML.stringify({
      packages: {
        npm: [{
          name: '@tencent/tokenlint',
          version: 'latest',
          global: true,
          registry: 'https://mirrors.tencent.com/npm/',
        }],
      },
    }));
    expect((await loadPackageManifest(dir)).packages.npm?.[0]).toEqual({
      name: '@tencent/tokenlint',
      version: 'latest',
      global: true,
      registry: 'https://mirrors.tencent.com/npm/',
    });

    fs.writeFileSync(path.join(dir, 'teamai.yaml'), YAML.stringify({
      packages: {
        npm: [{
          name: '@tencent/tokenlint',
          registry: 'https://user:secret@registry.example.com/',
        }],
      },
    }));
    await expect(loadPackageManifest(dir)).rejects.toThrow('without embedded credentials');
  });

  it('reports malformed registry URLs without throwing from safeParse', () => {
    expect(() => NpmSpecSchema.safeParse({
      name: 'typescript',
      registry: 'registry.npmjs.org',
    })).not.toThrow();
    expect(NpmSpecSchema.safeParse({
      name: 'typescript',
      registry: 'registry.npmjs.org',
    }).success).toBe(false);
  });

  it('keeps package validation isolated from general team config loading', async () => {
    fs.writeFileSync(path.join(dir, 'teamai.yaml'), YAML.stringify({
      team: 'platform',
      repo: 'acme/team',
      packages: {
        npm: [{ name: 'typescript', registry: 'not-a-url' }],
      },
    }));

    expect(await loadTeamConfig(dir)).not.toBeNull();
    await expect(loadPackageManifest(dir)).rejects.toThrow('valid http(s) URL');
  });

  it('rejects misspelled package keys instead of silently stripping them', async () => {
    fs.writeFileSync(path.join(dir, 'teamai.yaml'), YAML.stringify({
      packages: {
        npm: [{ name: 'eslint', version: 'latest', globla: true }],
      },
    }));
    await expect(loadPackageManifest(dir)).rejects.toThrow('Unrecognized key');

    fs.writeFileSync(path.join(dir, 'teamai.yaml'), YAML.stringify({
      packages: {
        npn: [{ name: 'eslint', version: 'latest' }],
      },
    }));
    await expect(loadPackageManifest(dir)).rejects.toThrow('Unrecognized key');
  });

  it('updates only packages and preserves existing team config keys', async () => {
    fs.writeFileSync(path.join(dir, 'teamai.yaml'), YAML.stringify({
      team: 'platform',
      repo: 'acme/team',
      reviewers: ['alice'],
    }));
    await savePackageManifest(dir, {
      name: 'platform',
      packages: { npm: [{ name: 'typescript', version: '*' }] },
    });

    const raw = YAML.parse(fs.readFileSync(path.join(dir, 'teamai.yaml'), 'utf8'));
    expect(raw.team).toBe('platform');
    expect(raw.repo).toBe('acme/team');
    expect(raw.reviewers).toEqual(['alice']);
    expect(raw.packages.npm[0].name).toBe('typescript');
  });

  it('round-trips teamai.lock and records a stable declaration hash', async () => {
    const manifest = {
      name: 'platform',
      packages: { npm: [{ name: 'typescript', version: '*' }] },
    };
    const declarationHash = packageDeclarationHash(manifest);
    await savePackageLock(dir, {
      version: 1,
      declarationHash,
      packages: {
        npm: [{ name: 'typescript', version: '5.9.2', source: 'npm' }],
      },
    });

    expect(await loadPackageLock(dir)).toEqual({
      version: 1,
      declarationHash,
      packages: {
        npm: [{ name: 'typescript', version: '5.9.2', source: 'npm' }],
      },
    });
    expect(packageDeclarationHash(manifest)).toBe(declarationHash);
  });
});
