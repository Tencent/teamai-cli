import { createHash } from 'node:crypto';
import { canonicalJson } from '../utils/canonical-json.js';
import type { RunSubject } from './label.js';

/**
 * Whether `scorer` judges `subject` at `samplingRate` percent. The same scorer and pass give the same answer on every
 * read and every machine; 0 never samples and 100 always does.
 */
export function isSampled(scorer: string, subject: RunSubject, samplingRate: number): boolean {
  if (samplingRate <= 0) return false;
  if (samplingRate >= 100) return true;
  const digest = createHash('sha256').update(canonicalJson({ scorer, ...subject })).digest();
  return digest.readUInt32BE(0) % 10_000 < samplingRate * 100;
}
