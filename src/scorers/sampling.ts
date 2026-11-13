import { createHash } from 'node:crypto';
import { canonicalJson } from '../utils/canonical-json.js';
import type { JsonObject } from '@teamai/shared/json';
import type { RunSubject, SessionSubject } from './label.js';

/**
 * Whether `scorer` judges `subject` at `samplingRate` percent. The same scorer and subject give the same answer on every
 * read and every machine; 0 never samples and 100 always does.
 */
export function isSampled(scorer: string, subject: RunSubject | SessionSubject, samplingRate: number): boolean {
  return isKeySampled({ scorer, ...subject }, samplingRate);
}

/** Whether `key` falls under `rate` percent, by a hash of its canonical JSON: the same on every read and every machine. */
export function isKeySampled(key: JsonObject, rate: number): boolean {
  if (rate <= 0) return false;

  if (rate >= 100) return true;
  const digest = createHash('sha256').update(canonicalJson(key)).digest();

  return digest.readUInt32BE(0) % 10_000 < rate * 100;
}
