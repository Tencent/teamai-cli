import path from 'node:path';
import { constants } from 'node:fs';
import { link, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { CodebaseCmdOptions } from '../codebase-cmd.js';
import { buildKnowledgePayload } from './producer.js';
import { inputSchema, MAX_PACK_BYTES, serializePack } from './schema.js';

export async function buildKnowledgePackCommand(options: CodebaseCmdOptions): Promise<void> {
  try {
    if (!options.output) throw new Error('Knowledge previews require --output <directory>.');
    if (options.extract || options.lint || options.reconcile || options.deepEnrich || options.status ||
        options.upgradeWiki || options.incremental || options.fix || options.project || options.maxFiles) {
      throw new Error('--knowledge-manifest cannot be combined with other codebase operations.');
    }
    const manifestPath = path.resolve(options.knowledgeManifest!);
    if ((await stat(manifestPath)).size > 1024 * 1024) throw new Error('Knowledge manifest is too large.');
    let value: unknown;
    try { value = JSON.parse(await readFile(manifestPath, 'utf8')); }
    catch { throw new Error('Knowledge manifest must be valid JSON.'); }
    const input = inputSchema.safeParse(value);
    if (!input.success) throw new Error('Invalid knowledge manifest. See docs/designs/knowledge-pack.md.');
    const payload = await buildKnowledgePayload(input.data, path.dirname(manifestPath));
    const serialized = serializePack(payload);
    if (Buffer.byteLength(serialized) > MAX_PACK_BYTES) throw new Error('Knowledge package exceeds the 16 MiB limit.');
    const hash = (JSON.parse(serialized) as { package_hash: string }).package_hash;
    const outputPath = path.join(path.resolve(options.output), `knowledge-pack-${hash}.json`);
    if (!options.dryRun) await writeImmutablePack(outputPath, serialized);
    const result = {
      status: 'preview', package_hash: hash, output: options.dryRun ? null : outputPath,
      dry_run: Boolean(options.dryRun), source_count: payload.sources.length,
      object_count: payload.objects.length, relation_count: payload.relations.length,
      warnings: payload.coverage.warnings,
    };
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(options.dryRun ? 'Knowledge preview validated (dry run; no files written).' : `Knowledge preview written: ${outputPath}`);
      console.log(`Sources: ${result.source_count}; objects: ${result.object_count}; candidate relations: ${result.relation_count}.`);
      console.log('Local development preview only. This is not a published or authorized team resource.');
      for (const warning of result.warnings) console.log(`Warning: ${warning}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Knowledge preview failed.';
    if (options.json) console.log(JSON.stringify({ error: 'KNOWLEDGE_PREVIEW_FAILED', message }));
    else console.error(`Knowledge preview failed: ${message}`);
    process.exitCode = 1;
  }
}

async function writeImmutablePack(destination: string, content: string): Promise<void> {
  const directory = path.dirname(destination);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(path.join(directory, '.knowledge-preview-'));
  const staged = path.join(temporary, 'package.json');
  try {
    await writeFile(staged, content, { mode: 0o600, flag: 'wx' });
    try { await link(staged, destination); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await existing.stat();
        if (!info.isFile() || info.size !== Buffer.byteLength(content) || (await existing.readFile('utf8')) !== content) {
          throw new Error('Existing knowledge package differs; refusing to overwrite it.');
        }
      } finally { await existing.close(); }
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
