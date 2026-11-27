import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  detectProjectConfig: vi.fn(),
  requireInit: vi.fn(),
}));

vi.mock('@teamai/shared/log', () => ({
  log: {
    debug: vi.fn(),
    dim: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
  },
}));

import { detectProjectConfig } from '../config.js';
import { generateDigest } from '../digest.js';
import { log } from '@teamai/shared/log';

describe('teamai digest failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
  });

  it('exits 1 when the digest cannot be generated', async () => {
    vi.mocked(detectProjectConfig).mockRejectedValue(new Error('Invalid teamai.yaml'));

    await generateDigest();

    expect(log.error).toHaveBeenCalledWith('Failed to generate digest: Invalid teamai.yaml');
    expect(process.exitCode).toBe(1);
  });
});
