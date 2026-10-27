import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fse from 'fs-extra';
import os from 'node:os';
import path from 'node:path';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  detectProjectConfig: vi.fn().mockResolvedValue(null),
  loadLocalConfig: vi.fn(),
  loadTeamConfig: vi.fn(),
  loadStateForScope: vi.fn().mockResolvedValue({}),
}));

vi.mock('../utils/logger.js', () => ({
  log: {
    debug: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), dim: vi.fn(),
  },
  setStderrOnly: vi.fn(),
  isSilent: () => false,
  setSilent: vi.fn(),
}));

import { loadLocalConfig, loadTeamConfig } from '../config.js';
import { buildChecks, resolveDoctorContext } from '../doctor.js';
import { DEFAULT_TOOL_PATHS, TeamaiConfigSchema, type LocalConfig } from '../types.js';

describe('doctor install checks under a moved home', () => {
  let root: string;
  let home: string;

  beforeEach(async () => {
    root = await fse.realpath(await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-doctor-moved-')));
    home = path.join(root, 'home');
    await fse.ensureDir(home);
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(root);
  });

  it('checks the Pi extension when PI_CODING_AGENT_DIR holds Pi and ~/.pi does not exist', async () => {
    const agentDir = path.join(root, 'pi-agent');
    await fse.ensureDir(agentDir);
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
    const localConfig: LocalConfig = {
      repo: { localPath: path.join(root, 'repo'), remote: 'owner/repo' },
      username: 'tester', scope: 'user', additionalRoles: [], enabledAgents: ['pi'],
    };
    vi.mocked(loadLocalConfig).mockResolvedValue(localConfig);
    vi.mocked(loadTeamConfig).mockResolvedValue(TeamaiConfigSchema.parse({ team: 't', repo: 'r', toolPaths: { pi: DEFAULT_TOOL_PATHS.pi } }));
    const ctx = await resolveDoctorContext();
    if (!ctx) throw new Error('expected a resolved doctor context');

    const names = (await buildChecks(ctx)).map((check) => check.name);

    expect(names).toContain('teamai hooks in pi extension');
  });
});
