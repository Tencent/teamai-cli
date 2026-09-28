import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ModelProfileSchema,
  ModelProfilesFileSchema,
  getTeamValuesPath,
  loadModelInputs,
  profileAgents,
  profileRoutes,
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
  it('names local team secrets with a readable, collision-resistant team identity', async () => {
    const repo = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-model-team-'));
    try {
      await fse.writeFile(path.join(repo, 'teamai.yaml'), 'team: HAI Platform\n');
      const file = getTeamValuesPath({ repo: { localPath: repo, remote: 'origin', url: 'https://example.test/hai' } } as LocalConfig);
      expect(path.basename(file)).toMatch(/^hai-platform-[a-f0-9]{10}\.json$/);
      expect(path.dirname(file)).toContain(path.join('models', 'teams'));
      const other = getTeamValuesPath({ repo: { localPath: `${repo}-other`, remote: 'origin', url: 'https://example.test/other' } } as LocalConfig);
      expect(path.basename(other).match(/-([a-f0-9]{10})\.json$/)?.[1])
        .not.toBe(path.basename(file).match(/-([a-f0-9]{10})\.json$/)?.[1]);
    } finally {
      await fse.remove(repo);
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
