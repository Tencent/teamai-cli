import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { z } from 'zod';

import { ImportFromRepo } from '../../import-from-repo.js';
import { RUN_DIR_ENV } from '../../launch-context.js';
import { log } from '../../utils/logger.js';
import type { ShortcutEnd, ShortcutRun } from '../../workflow-commands.js';

/** What the AI work of each item answers in place of the tool. */
export interface ImportStepAnswers {
  /** The narrative of a repository, by its URL; '' with no failure writes none. */
  narrative?: (url: string) => { text: string; failure: string };
  /** How the item's teamai-codebase-deep-enrich run ended, by slug: complete, incomplete, or failed with a message. */
  deep?: (slug: string) => 'complete' | 'incomplete' | { failure: string };
}

const InputsSchema = z.object({
  wiki_root: z.string(),
  mode: z.string(),
  items: z.array(z.record(z.string(), z.unknown())),
  settings: z.record(z.string(), z.unknown()),
  skipped: z.number(),
});

/**
 * The run `runShortcut` starts for teamai-import-from-repo, driven in this process: each step's verb in the order the
 * workflow runs them, the items one at a time, with `answers` standing in for the tool. Prints the run's text and sets
 * its exit code as `runShortcut` does.
 */
export async function runImportSteps(run: ShortcutRun, answers: ImportStepAnswers = {}): Promise<ShortcutEnd> {
  const inputs = InputsSchema.parse(run.inputs);
  const settings = JSON.stringify(inputs.settings);
  const wikiRoot = inputs.wiki_root;
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-import-run-'));
  const previous = process.env[RUN_DIR_ENV];
  process.env[RUN_DIR_ENV] = runDir;
  const results: Array<{ item: Record<string, unknown>; outcome: string; outputs: Record<string, unknown> | null }> = [];

  try {
    for (const entry of inputs.items) {
      const item = JSON.stringify(entry);

      try {
        const staged = await ImportFromRepo.stage({ item, settings, wikiRoot });
        const narrative = staged.narrate ? answers.narrative?.(String(entry['source'])) ?? { text: '', failure: '' } : { text: '', failure: '' };
        let deep = '';
        let deepFailure = '';

        if (staged.updated) {
          const published = await ImportFromRepo.publish({ item, settings, wikiRoot, stage: staged.stage, slug: staged.slug, narrative: narrative.text, narrativeFailure: narrative.failure });

          if (published.deep) {
            const ended = answers.deep?.(staged.slug) ?? 'complete';

            if (typeof ended === 'object') deepFailure = ended.failure;
            else deep = String(ended === 'complete');
          }
        }

        const done = staged.finished ? undefined : await ImportFromRepo.finishItem({ item, settings, wikiRoot, mode: inputs.mode, slug: staged.slug, head: staged.head, deep, deepFailure });
        results.push({ item: entry, outcome: 'success', outputs: { slug: staged.slug, updated: staged.updated, deep_complete: done?.deep_complete ?? null } });
      } catch (error) {
        log.error(error instanceof Error ? error.message : String(error));
        results.push({ item: entry, outcome: 'failed', outputs: null });
      }
    }

    const end = await ImportFromRepo.finish({ mode: inputs.mode, wikiRoot, settings, skipped: String(inputs.skipped), results: JSON.stringify(results) });

    if (end.text !== '') process.stdout.write(`${end.text}\n`);
    process.exitCode = end.exit_code;

    return { run: 'run-1', outcome: 'succeeded', outputs: { ...end } };
  } finally {
    if (previous === undefined) delete process.env[RUN_DIR_ENV];
    else process.env[RUN_DIR_ENV] = previous;
    await fs.remove(runDir);
  }
}
