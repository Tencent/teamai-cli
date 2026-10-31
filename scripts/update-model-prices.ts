/**
 * Regenerates `src/token-usage/model-prices.json` from the latest LiteLLM
 * commit that changed its price list. The catalog names that commit, so a
 * rerun with nothing new upstream rewrites the same bytes.
 *
 * Usage: node scripts/update-model-prices.mjs [--summary <file>]
 *   --summary  also write a Markdown summary of the change (the weekly pull request's body)
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import type { PriceCatalog } from '../src/token-usage/pricing.js';
import { catalogFromLiteLlm, describeCatalogChange, formatCatalog } from './model-prices.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, 'src/token-usage/model-prices.json');
const COMMITS = 'https://api.github.com/repos/BerriAI/litellm/commits?path=model_prices_and_context_window.json&per_page=1';
const LatestCommit = z.array(z.object({ sha: z.string(), commit: z.object({ committer: z.object({ date: z.string() }) }) })).min(1);

async function fetchOk(url: string, accept: string): Promise<Response> {
  const headers: Record<string, string> = { accept, 'user-agent': 'teamai-cli-model-prices' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`GET ${url} failed: HTTP ${response.status}`);
  return response;
}

const [latest] = LatestCommit.parse(await (await fetchOk(COMMITS, 'application/vnd.github+json')).json());
const raw = `https://raw.githubusercontent.com/BerriAI/litellm/${latest.sha}/model_prices_and_context_window.json`;
const catalog = catalogFromLiteLlm(await (await fetchOk(raw, 'application/json')).json(), {
  revision: latest.sha,
  date: latest.commit.committer.date.slice(0, 10),
});
const previous = JSON.parse(await fs.readFile(TARGET, 'utf8')) as PriceCatalog;
await fs.writeFile(TARGET, formatCatalog(catalog));
const summary = describeCatalogChange(previous, catalog);
const summaryAt = process.argv.indexOf('--summary');
if (summaryAt !== -1 && process.argv[summaryAt + 1]) await fs.writeFile(process.argv[summaryAt + 1], `${summary}\n`);
console.log(`Wrote ${Object.keys(catalog.models).length} models (${catalog.version}) to ${path.relative(ROOT, TARGET)}`);
console.log(summary.split('\n')[0]);
