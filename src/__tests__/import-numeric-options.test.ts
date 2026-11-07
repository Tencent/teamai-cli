// -*- coding: utf-8 -*-
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../import-org.js', () => ({
    importFromOrg: vi.fn(async () => {}),
}));

import { importCmd } from '../import.js';
import { importFromOrg } from '../import-org.js';
import { log } from '../utils/logger.js';

describe('importCmd --max-repos', () => {
    let exitSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.mocked(importFromOrg).mockClear();
        exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
        errorSpy = vi.spyOn(log, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('passes a valid --max-repos through as a number', async () => {
        await importCmd({ fromOrg: 'acme', maxRepos: '25' });

        expect(importFromOrg).toHaveBeenCalledWith(expect.objectContaining({ maxRepos: 25 }));
    });

    it('defaults to 200 when --max-repos is not given', async () => {
        await importCmd({ fromOrg: 'acme' });

        expect(importFromOrg).toHaveBeenCalledWith(expect.objectContaining({ maxRepos: 200 }));
    });

    it.each(['abc', '0', '-3', '1.5'])('refuses --max-repos %s instead of passing NaN or a bad cap', async (value) => {
        await importCmd({ fromOrg: 'acme', maxRepos: value });

        expect(importFromOrg).not.toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalledWith('--max-repos must be a positive integer');
        expect(exitSpy).toHaveBeenCalledWith(1);
    });
});
