import crypto from 'node:crypto';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ModelProfileSchema,
  ModelProfilesFileSchema,
  getTeamIdentity,
  getTeamValuesPath,
  loadModelInputs,
  migrateTeamValuesPath,
  profileAgents,
  profileRoutes,
  sameTeamIdentity,
  saveLocalProfiles,
  resolveProfile,
  resolveProfileRef,
  type ModelProfilesFile,
} from '../models/profile.js';
import type { LocalConfig } from '../types.js';

const TOKENHUB = {
  id: 'tokenhub',
  name: 'Tencent TokenHub',
  base_url: 'https://tokenhub.tencentmaas.com',
  api_key: '${API_KEY}',
  model_groups: [{ protocols: ['anthropic', 'openai-chat-completions'], models: ['glm-5.3', 'deepseek-v4-flash'] }],
};

function profile(id: string) {
  return ModelProfileSchema.parse({ ...TOKENHUB, id });
}

describe('model profiles', () => {
  it('names team secrets by repo identity alone, surviving teamai.yaml renames', async () => {
    const repo = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-model-team-'));
    try {
      await fse.writeFile(path.join(repo, 'teamai.yaml'), 'team: HAI Platform\n');
      const config = { repo: { localPath: repo, remote: 'origin', url: 'https://example.test/hai' } } as LocalConfig;
      const file = getTeamValuesPath(config);
      expect(path.basename(file)).toMatch(/^[a-f0-9]{10}\.json$/);
      expect(path.dirname(file)).toContain(path.join('models', 'teams'));
      // The team display name and a repo: claim must not move the file (#894).
      await fse.writeFile(path.join(repo, 'teamai.yaml'), 'team: Relocated\nrepo: https://example.test/elsewhere\n');
      expect(getTeamValuesPath(config)).toBe(file);
      // A different repository URL names a different file.
      const other = getTeamValuesPath({ repo: { localPath: `${repo}-other`, remote: 'origin', url: 'https://example.test/other' } } as LocalConfig);
      expect(path.basename(other)).not.toBe(path.basename(file));
      // scp and ssh URLs for the same repository name one file (#880 semantics).
      const scp = getTeamValuesPath({ repo: { localPath: repo, remote: 'origin', url: 'git@example.test:acme/team.git' } } as LocalConfig);
      const ssh = getTeamValuesPath({ repo: { localPath: repo, remote: 'origin', url: 'ssh://git@example.test:22/acme/team' } } as LocalConfig);
      expect(scp).toBe(ssh);
    } finally {
      await fse.remove(repo);
    }
  });

  it('matches the current hash name and only legacy digests this config could have produced', async () => {
    const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 10);
    const config = { repo: { localPath: '/tmp/example/hai', remote: 'origin', url: 'https://example.test/hai.git' } } as LocalConfig;
    expect(sameTeamIdentity(getTeamIdentity(config), config)).toBe(true);
    // A legacy name keyed by the URL digest names the same team.
    expect(sameTeamIdentity(`hai-platform-${digest('https://example.test/hai.git')}`, config)).toBe(true);
    // A legacy name keyed by a non-origin remote digest names the same team.
    const fork = { repo: { localPath: '/tmp/example/hai', remote: 'fork', url: 'https://example.test/hai.git' } } as LocalConfig;
    expect(sameTeamIdentity(`hai-platform-${digest('fork')}`, fork)).toBe(true);
    // A digest from another repository, or one this config never produced, must not match.
    expect(sameTeamIdentity(`hai-platform-${digest('https://example.test/other.git')}`, config)).toBe(false);
    expect(sameTeamIdentity('hai-platform-0000000000', config)).toBe(false);
    expect(sameTeamIdentity(undefined, config)).toBe(false);
    // The repo: claim in teamai.yaml overrode the identity in the old implementation,
    // so the stored digest is its: it must match (src/models/profile.ts).
    const claimRepo = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-model-claim-'));
    await fse.writeFile(path.join(claimRepo, 'teamai.yaml'), 'team: HAI Platform\nrepo: https://git.example.test/acme/team.git\n');
    const withClaim = { repo: { localPath: claimRepo, remote: 'origin', url: 'https://example.test/hai.git' } } as LocalConfig;
    try {
      expect(sameTeamIdentity(`hai-platform-${digest('https://git.example.test/acme/team.git')}`, withClaim)).toBe(true);
    } finally {
      await fse.remove(claimRepo);
    }
  });

  it('migrates the newest legacy file when several match, and renames nothing under dryRun', async () => {
    const previous = process.env.HOME;
    const home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-model-migrate3-'));
    process.env.HOME = home;
    try {
      const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 10);
      const config = { repo: { localPath: '/tmp/example/hai', remote: 'origin', url: 'https://example.test/hai.git' } } as LocalConfig;
      const target = getTeamValuesPath(config);
      const dir = path.dirname(target);
      await fse.ensureDir(dir);
      const stale = path.join(dir, `hai-platform-${digest('https://example.test/hai.git')}.json`);
      const staleContent = '{"team:gw":{"API_KEY":{"value":"stale"}}}';
      await fse.writeFile(stale, staleContent);
      const newer = path.join(dir, `relocated-${digest('https://example.test/hai.git')}.json`);
      const newerContent = '{"team:gw":{"API_KEY":{"value":"latest"}}}';
      await fse.writeFile(newer, newerContent);
      // Deterministic mtimes: the stale file is the older one, whatever readdir order returns.
      await fse.utimes(stale, new Date(1_000_000_000), new Date(1_000_000_000));
      await fse.utimes(newer, new Date(2_000_000_000), new Date(2_000_000_000));
      // Newer wins even when readdir sorts the stale file first.
      expect(await migrateTeamValuesPath(config)).toBe(target);
      expect(JSON.parse(await fse.readFile(target, 'utf8'))['team:gw']['API_KEY'].value).toBe('latest');
      expect(await fse.pathExists(stale)).toBe(true);
      expect(await fse.pathExists(newer)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
      await fse.remove(home);
    }
  });

  it('renames nothing when the caller passes dryRun', async () => {
    const previous = process.env.HOME;
    const home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-model-dryrun-'));
    process.env.HOME = home;
    try {
      const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 10);
      const config = { repo: { localPath: '/tmp/example/hai', remote: 'origin', url: 'https://example.test/hai.git' } } as LocalConfig;
      const target = getTeamValuesPath(config);
      const dir = path.dirname(target);
      await fse.ensureDir(dir);
      const legacy = path.join(dir, `hai-platform-${digest('https://example.test/hai.git')}.json`);
      await fse.writeFile(legacy, '{"team:gw":{"API_KEY":{"value":"old"}}}');
      expect(await migrateTeamValuesPath(config, { dryRun: true })).toBe(target);
      expect(await fse.pathExists(target)).toBe(false);
      expect(await fse.readFile(legacy, 'utf8')).toBe('{"team:gw":{"API_KEY":{"value":"old"}}}');
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
      await fse.remove(home);
    }
  });

  it('never migrates or adopts a foreign team digest', async () => {
    const previous = process.env.HOME;
    const home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-model-foreign-'));
    process.env.HOME = home;
    try {
      const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 10);
      const config = { repo: { localPath: '/tmp/example/hai', remote: 'origin', url: 'https://example.test/hai.git' } } as LocalConfig;
      const target = getTeamValuesPath(config);
      const dir = path.dirname(target);
      await fse.ensureDir(dir);
      // Another team's values file shares the slug but not the digest.
      const foreign = path.join(dir, `hai-platform-${digest('https://example.test/foreign.git')}.json`);
      await fse.writeFile(foreign, 'foreign');
      expect(await migrateTeamValuesPath(config)).toBe(target);
      expect(await fse.pathExists(target)).toBe(false);
      expect(await fse.pathExists(foreign)).toBe(true);
      expect(sameTeamIdentity(`hai-platform-${digest('https://example.test/foreign.git')}`, config)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
      await fse.remove(home);
    }
  });

  it('migrates a legacy slug-digest values file to the hash-only name', async () => {
    const previous = process.env.HOME;
    const home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-model-migrate-'));
    process.env.HOME = home;
    try {
      const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 10);
      const config = { repo: { localPath: '/tmp/example/hai', remote: 'origin', url: 'https://example.test/hai.git' } } as LocalConfig;
      const target = getTeamValuesPath(config);
      const dir = path.dirname(target);
      await fse.ensureDir(dir);
      const legacy = path.join(dir, `hai-platform-${digest('https://example.test/hai.git')}.json`);
      await fse.writeFile(legacy, '{"team:gw":{"API_KEY":{"value":"old"}}}');
      expect(await migrateTeamValuesPath(config)).toBe(target);
      expect(await fse.pathExists(target)).toBe(true);
      expect(await fse.pathExists(legacy)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
      await fse.remove(home);
    }
  });

  it('keeps the hash-only file when present and never migrates a foreign digest', async () => {
    const previous = process.env.HOME;
    const home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-model-migrate2-'));
    process.env.HOME = home;
    try {
      const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 10);
      const config = { repo: { localPath: '/tmp/example/hai', remote: 'origin', url: 'https://example.test/hai' } } as LocalConfig;
      const target = getTeamValuesPath(config);
      const dir = path.dirname(target);
      await fse.ensureDir(dir);
      await fse.writeFile(target, 'current');
      const foreign = path.join(dir, `hai-platform-${digest('https://example.test/foreign.git')}.json`);
      await fse.writeFile(foreign, 'foreign');
      // Target exists: the foreign legacy file is left alone.
      expect(await migrateTeamValuesPath(config)).toBe(target);
      expect(await fse.readFile(target, 'utf8')).toBe('current');
      expect(await fse.pathExists(foreign)).toBe(true);
      // No matching legacy file: still returns the path without creating anything.
      await fse.remove(target);
      expect(await migrateTeamValuesPath(config)).toBe(target);
      expect(await fse.pathExists(target)).toBe(false);
      expect(await fse.pathExists(foreign)).toBe(true);
      // Missing teams directory entirely: same graceful return.
      await fse.remove(dir);
      expect(await migrateTeamValuesPath(config)).toBe(target);
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
      await fse.remove(home);
    }
  });

  it('resolves model groups into protocol routes without repeating model IDs', () => {
    const parsed = ModelProfileSchema.parse({
      ...TOKENHUB,
      model_groups: [
        { protocols: ['anthropic'], models: ['claude-opus-4-8'] },
        { protocols: ['anthropic', 'openai-chat-completions'], models: ['deepseek-v4-flash'] },
      ],
    });
    const resolved = resolveProfile(
      { source: 'team', profile: parsed },
      { 'team:tokenhub@https://tokenhub.tencentmaas.com': { API_KEY: { value: 'local-secret' } } },
    );
    expect(resolved.routes.anthropic).toEqual({
      base_url: 'https://tokenhub.tencentmaas.com',
      models: ['claude-opus-4-8', 'deepseek-v4-flash'],
    });
    expect(resolved.routes['openai-chat-completions']).toEqual({
      base_url: 'https://tokenhub.tencentmaas.com/v1',
      models: ['deepseek-v4-flash'],
    });
    expect(resolved.api_key_value).toBe('local-secret');
  });

  it('puts a chosen default model first in every route that serves it', () => {
    const values = { 'team:tokenhub@https://tokenhub.tencentmaas.com': { API_KEY: { value: 'local-secret' } } };
    const resolved = resolveProfile({ source: 'team', profile: profile('tokenhub') }, values, 'deepseek-v4-flash');
    expect(resolved.routes.anthropic?.models).toEqual(['deepseek-v4-flash', 'glm-5.3']);
    expect(resolved.routes['openai-chat-completions']?.models).toEqual(['deepseek-v4-flash', 'glm-5.3']);
    expect(() => resolveProfile({ source: 'team', profile: profile('tokenhub') }, values, 'missing-model'))
      .toThrow(/has no model missing-model/);
  });

  it('makes one three-protocol model available to each compatible agent', () => {
    const parsed = ModelProfileSchema.parse({
      ...TOKENHUB,
      model_groups: [{ protocols: ['anthropic', 'openai-chat-completions', 'openai-responses'], models: ['glm-5.3'] }],
    });
    expect(profileRoutes(parsed)).toEqual({
      anthropic: ['glm-5.3'],
      'openai-chat-completions': ['glm-5.3'],
      'openai-responses': ['glm-5.3'],
    });
    expect(profileAgents(parsed)).toEqual(['claude', 'codex', 'opencode', 'codebuddy', 'workbuddy']);
    expect(profileAgents(profile('tokenhub'))).toEqual(['claude', 'opencode', 'codebuddy', 'workbuddy']);
  });

  it('keeps api_key as a placeholder and rejects secrets or placeholders elsewhere', () => {
    expect(profileRoutes(ModelProfilesFileSchema.parse({ profiles: [TOKENHUB] }).profiles[0]).anthropic).toEqual(['glm-5.3', 'deepseek-v4-flash']);
    const invalid = (changes: Record<string, unknown>) => ModelProfilesFileSchema.parse({ profiles: [{ ...TOKENHUB, ...changes }] });
    expect(() => invalid({ api_key: 'sk-plaintext' })).toThrow(/configure the secret locally/);
    expect(() => invalid({ api_key: undefined })).toThrow(/api_key/);
    expect(() => invalid({ base_url: '${GATEWAY_URL}' })).toThrow(/http or https URL/);
    expect(() => invalid({ base_url: 'https://example.test/v1' })).toThrow(/without \/v1/);
    expect(() => invalid({ base_url: 'https://user:secret@example.test' })).toThrow(/without embedded credentials, query, or fragment/);
    expect(() => invalid({ base_url: 'https://example.test?api_key=sk-secret' })).toThrow(/without embedded credentials, query, or fragment/);
    expect(() => invalid({ base_url: 'https://example.test#sk-secret' })).toThrow(/without embedded credentials, query, or fragment/);
  });

  it('rejects unknown fields and repeated model IDs in a team catalog', () => {
    expect(() => ModelProfilesFileSchema.parse({ profiles: [TOKENHUB], credentials: 'plain-secret' })).toThrow(/Unrecognized key.*credentials/);
    expect(() => ModelProfilesFileSchema.parse({ profiles: [{ ...TOKENHUB, apiKey: 'plain-secret' }] })).toThrow(/Unrecognized key.*apiKey/);
    expect(() => ModelProfilesFileSchema.parse({ profiles: [{ ...TOKENHUB, agents: {} }] })).toThrow(/Unrecognized key.*agents/);
    expect(() => ModelProfilesFileSchema.parse({ profiles: [{ ...TOKENHUB, model_groups: [{ ...TOKENHUB.model_groups[0], credentials: 'plain-secret' }] }] })).toThrow(/Unrecognized key.*credentials/);
    expect(() => ModelProfilesFileSchema.parse({ profiles: [{ ...TOKENHUB, model_groups: [
      { protocols: ['anthropic'], models: ['one'] },
      { protocols: ['openai-responses'], models: ['one'] },
    ] }] })).toThrow(/duplicate model id one/);
  });

  it('saves a local profile in the team catalog format without a version header', async () => {
    const previous = process.env.HOME;
    const home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-model-save-'));
    process.env.HOME = home;
    try {
      await saveLocalProfiles(ModelProfilesFileSchema.parse({ profiles: [TOKENHUB] }));
      const raw = await fse.readFile(path.join(home, '.teamai', 'models', 'models.yaml'), 'utf8');
      expect(raw).not.toContain('version:');
      expect(raw).toContain('api_key: ${API_KEY}');
      expect(raw).toContain('base_url: https://tokenhub.tencentmaas.com');
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
      await fse.remove(home);
    }
  });

  it('fails closed without overwriting malformed local input JSON', async () => {
    const dir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-model-inputs-'));
    const file = path.join(dir, 'values.json');
    const malformed = '{"local:corp":';
    try {
      await fse.writeFile(file, malformed);
      await expect(loadModelInputs(file)).rejects.toThrow(/Cannot parse local model inputs/);
      expect(await fse.readFile(file, 'utf8')).toBe(malformed);
    } finally {
      await fse.remove(dir);
    }
  });

  it('requires a namespace when team and local IDs collide', () => {
    const team: ModelProfilesFile = { version: 1, profiles: [profile('same')] };
    const local: ModelProfilesFile = { version: 1, profiles: [profile('same')] };
    expect(() => resolveProfileRef('same', team, local)).toThrow(/Ambiguous.*team:same.*local:same/);
    expect(resolveProfileRef('local:same', team, local).source).toBe('local');
  });

  it('uses a team key only for the gateway origin it was stored for', () => {
    const values = { 'team:corp@https://tokenhub.tencentmaas.com': { API_KEY: { value: 'company-secret' } } };
    const samehost = ModelProfileSchema.parse({ ...TOKENHUB, id: 'corp', base_url: 'https://tokenhub.tencentmaas.com/project' });
    expect(resolveProfile({ source: 'team', profile: samehost }, values).api_key_value).toBe('company-secret');
    const otherhost = ModelProfileSchema.parse({ ...TOKENHUB, id: 'corp', base_url: 'https://gateway.project.test' });
    expect(() => resolveProfile({ source: 'team', profile: otherhost }, values))
      .toThrow(/team:corp has no API key for https:\/\/gateway\.project\.test/);
    // A key stored by id alone is never used without the root profile it was configured for.
    expect(() => resolveProfile({ source: 'team', profile: profile('corp') }, { 'team:corp': { API_KEY: { value: 'old' } } }))
      .toThrow(/has no API key/);
  });

  it('resolves environment-backed keys without persisting their values', () => {
    const values = { 'team:corp@https://tokenhub.tencentmaas.com': { API_KEY: { env: 'TEAMAI_TEST_MODEL_KEY' } } };
    process.env.TEAMAI_TEST_MODEL_KEY = 'from-env';
    try {
      const resolved = resolveProfile({ source: 'team', profile: profile('corp') }, values);
      expect(resolved.api_key_value).toBe('from-env');
      expect(resolved.api_key_env).toBe('TEAMAI_TEST_MODEL_KEY');
    } finally {
      delete process.env.TEAMAI_TEST_MODEL_KEY;
    }
    expect(() => resolveProfile({ source: 'team', profile: profile('corp') }, values))
      .toThrow(/TEAMAI_TEST_MODEL_KEY is not set/);
  });
});
