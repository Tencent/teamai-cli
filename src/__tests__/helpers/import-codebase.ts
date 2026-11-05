import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';

import { writeEnrichResult, type EnrichResult } from '../../enrich-with-ai.js';
import { extractToStaging, publishStaging, type ImportCodebaseOptions } from '../../import-codebase.js';

/**
 * One codebase as a teamai-import-from-repo run imports it: extracted into a staging teamwiki, given what
 * teamai-codebase-enrich found (`enriched`) unless `skipEnrich`, then published. False when nothing was staged.
 */
export async function importCodebase(opts: ImportCodebaseOptions & { enriched?: EnrichResult }): Promise<boolean> {
  const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-import-stage-'));

  try {
    if (!(await extractToStaging({ ...opts, stagingRoot }))) return false;

    if (!opts.skipEnrich && opts.enriched) await writeEnrichResult(opts.enriched, path.join(stagingRoot, 'teamwiki', 'evidence', 'code', opts.slug));
    await publishStaging({ ...opts, stagingRoot });

    return true;
  } finally {
    await fs.remove(stagingRoot);
  }
}
