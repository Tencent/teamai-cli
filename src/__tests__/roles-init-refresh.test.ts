import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  autoDetectInit: vi.fn(), pullRepo: vi.fn(), pushRepoBranch: vi.fn(),
  checkoutMaster: vi.fn(), generateBranchName: vi.fn(() => 'init-roles'),
  askQuestion: vi.fn(), askConfirmation: vi.fn(), pathExists: vi.fn(),
  saveRolesManifest: vi.fn(), createPrWithFallback: vi.fn(),
}));
vi.mock('../config.js', () => ({ autoDetectInit: mocks.autoDetectInit }));
vi.mock('../utils/git.js', () => mocks);
vi.mock('../utils/prompt.js', () => mocks);
vi.mock('../utils/fs.js', () => ({ pathExists: mocks.pathExists }));
vi.mock('../roles.js', () => ({ saveRolesManifest: mocks.saveRolesManifest }));
vi.mock('../push.js', () => ({ createPrWithFallback: mocks.createPrWithFallback }));
vi.mock('../utils/logger.js', () => ({
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn() },
  spinner: () => ({ start: () => ({ succeed: vi.fn(), warn: vi.fn() }) }),
}));

import { rolesInit } from '../roles-cmd.js';

describe('roles init refresh ordering', () => {
  beforeEach(() => vi.resetAllMocks());

  it('does not retrieve and overwrite a manifest added upstream during the questions', async () => {
    let checkedOutManifest: unknown;
    let pulls = 0;
    mocks.autoDetectInit.mockResolvedValue({
      localConfig: { repo: { localPath: '/team-repo' }, username: 'admin' }, teamConfig: {},
    });
    mocks.pullRepo.mockImplementation(async () => {
      if (++pulls === 2) checkedOutManifest = { roles: [{ id: 'other-admin' }] };
    });
    mocks.pathExists.mockImplementation(async () => checkedOutManifest !== undefined);
    mocks.askQuestion.mockResolvedValueOnce('new-role').mockResolvedValueOnce('').mockResolvedValueOnce('common');
    mocks.askConfirmation.mockResolvedValue(false);
    const overwritten: unknown[] = [];
    mocks.saveRolesManifest.mockImplementation(async (_path, manifest) => {
      if (checkedOutManifest) overwritten.push(checkedOutManifest);
      checkedOutManifest = manifest;
    });
    mocks.pushRepoBranch.mockResolvedValue(false);

    await rolesInit({});

    expect(mocks.saveRolesManifest).toHaveBeenCalled();
    expect(overwritten).toEqual([]);
    expect(pulls).toBe(1);
  });
});
