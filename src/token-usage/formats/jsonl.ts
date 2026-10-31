import fs from 'node:fs';
import readline from 'node:readline';

import { log } from '../../utils/logger.js';
import { INTERVENTION_SCAN_MAX_BYTES } from '../../types.js';

/**
 * Stream a JSONL transcript, handing each parsed line that contains one of
 * `markers` to `visit`. Missing, unreadable, empty and oversized files visit
 * nothing; unparseable lines are skipped.
 */
export async function forEachJsonLine(
  file: string,
  markers: readonly string[],
  visit: (entry: unknown) => void,
): Promise<void> {
  let size: number;
  try {
    size = (await fs.promises.stat(file)).size;
  } catch {
    return;
  }
  if (size > INTERVENTION_SCAN_MAX_BYTES) {
    log.warn(`token-usage: transcript too large to read (${size} bytes): ${file}`);
    return;
  }
  const lines = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf-8' }), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!markers.some((marker) => line.includes(marker))) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      visit(entry);
    }
  } catch (e) {
    // A transcript that cannot be read leaves usage unknown; the Stop is still recorded.
    log.warn(`token-usage: could not read ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
