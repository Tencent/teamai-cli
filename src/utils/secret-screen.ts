import fs from 'node:fs/promises';
import path from 'node:path';

import { entriesUnder } from '@teamai/shared/entries-under';
import { readRegularFile } from '@teamai/shared/regular-file';
import { findRedactions } from '@teamai/shared/redact';

/**
 * Secret screening for `teamai push` (#2023).
 *
 * A file that carries a live token is otherwise pushed to the team repo without
 * a word and delivered to every tool directory on every member's machine
 * (#1743). Screening reuses `findRedactions()` — the catalogue behind
 * `redact()`, as labels rather than rewritten text — and tiers the verdict:
 *
 * - **refuse**: a precise secret shape (vendor prefixes, PEM blocks, JWTs,
 *   bearer headers, connection strings). These essentially never occur in
 *   documentation, so push refuses them (`--allow-secrets` overrides).
 * - **warn**: the loose `key=value` pair and literal environment values. Both
 *   land in honest docs often enough that refusing them would get the whole
 *   screen disabled by the first team it blocks; the report still names the
 *   file and the line, and push proceeds.
 *
 * It never echoes the matched content, only the file, the line numbers, the
 * tier, and the matched label. `env` resources are excluded on purpose: an env
 * file is credential-bearing by design and pushing one is the feature.
 *
 * The scan always runs to the end: {@link ScreenResult.refusalCount} counts
 * every refusal the selection carries, so the verdict cannot be missed behind
 * a report cap. The returned hits are capped per tier for readability only.
 */

export interface SecretHit {
  /** Team-relative path as the push reports it, with `/` separators. */
  file: string;
  /** 1-based line numbers, capped at {@link MAX_REPORTED_LINES}. */
  lines: number[];
  tier: SecretTier;
  /** The placeholder labels behind the hit, e.g. `gh_tok`, `kv`, `GITHUB_TOKEN`. */
  labels: string[];
}

export interface ScreenableItem {
  type: string;
  relativePath: string;
  sourcePath: string;
}

export type SecretTier = 'refuse' | 'warn';

export const MAX_REPORTED_LINES = 5;
export const MAX_REPORTED_FILES = 20;

/** Multi-line shapes (a PEM block) need a window; per-line passes miss them. The window grows if a block outgrows it. */
const WINDOW_LINES = 30;

/** Upper bound so a pathological file cannot spin the scan forever. */
const MAX_WINDOWS_PER_FILE = 400;

const BINARY_SNIFF_BYTES = 8000;

export function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

/**
 * `null` when clean; otherwise the tier the file's redactions deserve. A
 * precise shape refuses; loose pairs and environment values warn.
 */
export function screenText(text: string, envSecrets: Record<string, string>): SecretTier | null {
  const found = findRedactions(text, { envSecrets });

  if (found.length === 0) return null;

  return found.some((hit) => hit.layer === 'shape') ? 'refuse' : 'warn';
}

/**
 * 1-based line numbers of the lines that match, capped, for the file's tier:
 * single-line matches are filtered to that tier, so a warning line never
 * hides where the refusal actually sits, and a whole-text tier hit with no
 * single-line match is a multi-line shape — the first line of the first
 * matching window is reported so the pointer still lands somewhere real.
 */
export function findHitLines(text: string, envSecrets: Record<string, string>, tier: SecretTier): number[] {
  const lines = text.split('\n');

  // Scoped to the tier: shape layers for a refusal, the loose layers for a warning.
  const matchesTier = (value: string): boolean => {
    const found = findRedactions(value, { envSecrets });

    return tier === 'refuse' ? found.some((hit) => hit.layer === 'shape') : found.some((hit) => hit.layer !== 'shape');
  };

  const hits: number[] = [];

  for (let i = 0; i < lines.length && hits.length < MAX_REPORTED_LINES; i++) {
    const line = lines[i];

    if (line && matchesTier(line)) hits.push(i + 1);
  }

  if (hits.length === 0) {
    // A multi-line shape (a PEM block) never matches a single line, and a
    // fixed-size window cannot hold a block longer than itself, so the window
    // grows until one fits — then trims its head down to the block's first
    // line, the exact BEGIN the scrub should start at. The probe budget is
    // per window size: exhausting it at one size must not starve the size
    // that would actually fit the block.
    for (let w = Math.min(WINDOW_LINES, lines.length); ; w = Math.min(w * 2, lines.length)) {
      for (let start = 0; start + w <= lines.length && start < MAX_WINDOWS_PER_FILE; start += 1) {
        const window = lines.slice(start, start + w).join('\n');

        if (window && matchesTier(window)) {
          let blockStart = start;

          while (blockStart + 1 < start + w && matchesTier(lines.slice(blockStart + 1, start + w).join('\n'))) blockStart += 1;

          hits.push(blockStart + 1);

          return hits;
        }
      }

      if (w >= lines.length) break;
    }

    // A block longer than every window still gets a line rather than an empty "at line".
    if (matchesTier(text)) hits.push(1);
  }

  return hits;
}

function walkFiles(dir: string): string[] {
  return entriesUnder(dir)
    .filter(({ entry }) => entry.isFile())
    .map(({ relative }) => path.join(dir, relative));
}

/**
 * Screen the selected push items. Env resources are skipped by design; binary
 * files are skipped by content sniffing. At most {@link MAX_REPORTED_FILES}
 * hits are returned — the verdict applies either way, the cap only keeps the
 * report readable when a whole directory tree is dirty.
 */
export interface ScreenResult {
  /** Refusals first, then warnings; each list capped at {@link MAX_REPORTED_FILES} for the report. */
  hits: SecretHit[];
  /** Complete refusal count — the verdict and the cap note come from this, never from the capped report. */
  refusalCount: number;
  /** Complete warning count. */
  warnCount: number;
}

export async function screenPushItems(
  items: readonly ScreenableItem[],
  envSecrets: Record<string, string>,
): Promise<ScreenResult> {
  const refusals: SecretHit[] = [];
  const warnings: SecretHit[] = [];
  let refusalCount = 0;
  let warnCount = 0;

  for (const item of items) {
    if (item.type === 'env') continue;

    const stat = await fs.stat(item.sourcePath).catch(() => undefined);

    if (!stat) continue;

    const files = stat.isDirectory() ? walkFiles(item.sourcePath) : [item.sourcePath];
    const sourceRoot = stat.isDirectory() ? item.sourcePath : path.dirname(item.sourcePath);

    for (const file of files) {
      const content = await readRegularFile(file);

      if (looksBinary(content)) continue;

      const text = content.toString('utf8');
      const found = findRedactions(text, { envSecrets });

      if (found.length === 0) continue;

      const tier = found.some((match) => match.layer === 'shape') ? 'refuse' : 'warn';
      const relative = path.relative(sourceRoot, file).split(path.sep).join('/');
      const displayPath = stat.isDirectory() ? `${item.relativePath}/${relative}` : item.relativePath;

      const report: SecretHit = {
        file: displayPath,
        lines: findHitLines(text, envSecrets, tier),
        tier,
        labels: found.map((match) => match.label),
      };

      if (tier === 'refuse') {
        refusalCount += 1;

        if (refusals.length < MAX_REPORTED_FILES) refusals.push(report);
      } else {
        warnCount += 1;

        if (warnings.length < MAX_REPORTED_FILES) warnings.push(report);
      }
    }
  }

  return { hits: [...refusals, ...warnings], refusalCount, warnCount };
}

/** One rendered report line per hit — `log.warn` for warns, `log.error` for refusals. */
export function formatSecretHits(hits: readonly SecretHit[]): Array<{ line: string; tier: SecretTier }> {
  return hits.map((hit) => {
    const labels = hit.labels.length > 0 ? ` (${hit.labels.slice(0, 3).join(', ')})` : '';
    const at = hit.lines.length === 1 ? `line ${hit.lines[0]}` : `line ${hit.lines.join(', ')}`;
    const head = hit.tier === 'refuse' ? `secret shape${labels}` : `possible secret${labels}`;

    return { line: `  ${hit.file}: ${head} at ${at}`, tier: hit.tier };
  });
}
