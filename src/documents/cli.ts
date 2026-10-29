
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { ArtifactsSchema, checkTaskDocuments, checkTaskLocation, documentPath, type SdlcStage } from './artifacts.js';
import { asKnowledge, readDocument } from './okf.js';

/** Packaged skill script entry; no top-level CLI command and no implicit file writes. */
export async function documentCheck(args = process.argv.slice(2)): Promise<void> {
  try {
    const { values } = parseArgs({ args, options: {
      workspace: { type: 'string' }, task: { type: 'string' }, stage: { type: 'string' },
      locate: { type: 'boolean' },
      expected: { type: 'string' }, file: { type: 'string' }, type: { type: 'string' }, migrate: { type: 'boolean' },
    } });
    if (values.file) {
      const file = await documentPath(process.cwd(), values.file);
      const before = await readFile(file, 'utf8');
      if (values.migrate) {
        if (!values.type) throw new Error('Migration preview requires --type from the document owner.');
        const after = asKnowledge(before, values.type, values.file);
        console.log(JSON.stringify({ ok: true, file: values.file, changed: before !== after, before, after }));
      } else {
        const document = readDocument(before, values.file);
        console.log(JSON.stringify({ ok: document.diagnostics.length === 0, file: values.file, diagnostics: document.diagnostics }));
        if (document.diagnostics.length) process.exitCode = 1;
      }
      return;
    }
    if (values.locate && values.workspace && values.task) {
      const directory = await checkTaskLocation(process.cwd(), values.workspace, values.task);
      console.log(JSON.stringify({ ok: true, directory }));
      return;
    }
    if (!values.workspace || !values.task || !values.stage) throw new Error('Pass --workspace, --task and --stage, or --file for a knowledge document.');
    const expected = values.expected ? ArtifactsSchema.parse(JSON.parse(values.expected)) : [];
    const artifacts = await checkTaskDocuments(process.cwd(), values.workspace, values.task, values.stage as SdlcStage, expected);
    console.log(JSON.stringify({ ok: true, artifacts }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
}

export { documentReview } from './review-cli.js';
