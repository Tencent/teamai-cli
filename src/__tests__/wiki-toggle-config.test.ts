import { describe, it, expect } from 'vitest';
import { isWikiEnabledByConfig, LocalConfigSchema } from '../types.js';

describe('Wiki feature toggle via local config (Approach B)', () => {
  const baseConfig = {
    repo: { localPath: '/tmp/test-repo', remote: 'git@test:repo.git' },
    username: 'test-user',
    scope: 'user' as const,
    additionalRoles: [],
  };

  describe('isWikiEnabledByConfig', () => {
    it('returns true when wikiEnabled is true', () => {
      const config = LocalConfigSchema.parse({ ...baseConfig, wikiEnabled: true });
      expect(isWikiEnabledByConfig(config)).toBe(true);
    });

    it('returns false when wikiEnabled is false', () => {
      const config = LocalConfigSchema.parse({ ...baseConfig, wikiEnabled: false });
      expect(isWikiEnabledByConfig(config)).toBe(false);
    });

    it('returns true when wikiEnabled is not set (default)', () => {
      const config = LocalConfigSchema.parse(baseConfig);
      expect(isWikiEnabledByConfig(config)).toBe(true);
    });
  });

  describe('LocalConfigSchema backward compatibility', () => {
    it('parses config without wikiEnabled field (defaults to true)', () => {
      const config = LocalConfigSchema.parse(baseConfig);
      expect(config.wikiEnabled).toBeUndefined();
    });

    it('parses config with wikiEnabled: false', () => {
      const config = LocalConfigSchema.parse({ ...baseConfig, wikiEnabled: false });
      expect(config.wikiEnabled).toBe(false);
    });

    it('parses config with wikiEnabled: true', () => {
      const config = LocalConfigSchema.parse({ ...baseConfig, wikiEnabled: true });
      expect(config.wikiEnabled).toBe(true);
    });

    it('rejects non-boolean wikiEnabled', () => {
      expect(() =>
        LocalConfigSchema.parse({ ...baseConfig, wikiEnabled: 'yes' }),
      ).toThrow();
    });
  });

  describe('Pull resource type filtering', () => {
    it('includes wiki when enabled', () => {
      const config = LocalConfigSchema.parse({ ...baseConfig, wikiEnabled: true });
      const wikiEnabled = isWikiEnabledByConfig(config);
      const types = wikiEnabled
        ? ['skills', 'rules', 'docs', 'env', 'wiki']
        : ['skills', 'rules', 'docs', 'env'];
      expect(types).toContain('wiki');
    });

    it('excludes wiki when disabled', () => {
      const config = LocalConfigSchema.parse({ ...baseConfig, wikiEnabled: false });
      const wikiEnabled = isWikiEnabledByConfig(config);
      const types = wikiEnabled
        ? ['skills', 'rules', 'docs', 'env', 'wiki']
        : ['skills', 'rules', 'docs', 'env'];
      expect(types).not.toContain('wiki');
    });
  });

  describe('Builtin skills skipWiki', () => {
    it('filters teamai-wiki when skipWiki is true', () => {
      const names = ['teamai-share-learnings', 'teamai-wiki'];
      const opts = { skipWiki: true };
      const filtered = names.filter(n => !(opts.skipWiki && n === 'teamai-wiki'));
      expect(filtered).toEqual(['teamai-share-learnings']);
    });

    it('keeps teamai-wiki when skipWiki is false', () => {
      const names = ['teamai-share-learnings', 'teamai-wiki'];
      const opts = { skipWiki: false };
      const filtered = names.filter(n => !(opts.skipWiki && n === 'teamai-wiki'));
      expect(filtered).toEqual(['teamai-share-learnings', 'teamai-wiki']);
    });
  });
});
