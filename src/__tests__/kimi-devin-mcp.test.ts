import os from 'node:os';
import path from 'node:path';
import fse from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveMcpTargets } from '../mcp-reconcile.js';
import { detectMcpFormat, renderJsonEntry } from '../resources/mcp-format.js';
import { TeamaiConfigSchema } from '../types.js';
import type { LocalConfig } from '../types.js';

describe('Kimi Code and Devin MCP', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('names the transport in a `transport` key', () => {
    expect(detectMcpFormat('kimi')).toBe('kimi');
    expect(detectMcpFormat('devin')).toBe('kimi');
    expect(renderJsonEntry('kimi', { name: 'a', transport: 'stdio', command: 'node', args: ['x.js'] }))
      .toEqual({ transport: 'stdio', command: 'node', args: ['x.js'] });
    expect(renderJsonEntry('kimi', {
      name: 'b', transport: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer t' },
    })).toEqual({ transport: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer t' } });
  });

  it('resolves the user-scope MCP files of installed Kimi Code and Devin', async () => {
    const home = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-kimi-devin-mcp-'));
    try {
      await fse.ensureDir(path.join(home, '.kimi-code', 'skills'));
      await fse.ensureDir(path.join(home, '.config', 'devin', 'skills'));
      vi.stubEnv('HOME', home);
      const config = TeamaiConfigSchema.parse({ team: 'test', repo: 'test/repo' });
      const localConfig = {
        repo: { localPath: path.join(home, 'team-repo'), remote: 'test/repo' },
        username: 'test',
        scope: 'user',
        additionalRoles: [],
      } as unknown as LocalConfig;

      const targets = await resolveMcpTargets(config, localConfig);
      expect(targets).toContainEqual({
        tool: 'kimi', format: 'kimi', file: path.join(home, '.kimi-code', 'mcp.json'), projectScope: false,
      });
      expect(targets).toContainEqual({
        tool: 'devin', format: 'kimi', file: path.join(home, '.config', 'devin', 'mcp_config.json'), projectScope: false,
      });
    } finally {
      await fse.remove(home);
    }
  });
});
