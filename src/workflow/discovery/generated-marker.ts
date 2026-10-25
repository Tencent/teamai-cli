/**
 * The marker `teamai pull` puts in each skill it generates from a workflow: frontmatter
 * `metadata.teamai-generated: workflow/<name> sha256:<hex>`, where the digest covers the whole file with that value
 * blanked. A file whose marker parses is ours; one whose digest also matches is ours and unedited, which is the proof
 * pull needs before it rewrites or removes it.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readFileSafe } from '../../utils/fs.js';

const MARKER = /^( {2}teamai-generated: )(.*)$/m;
const VALUE = /^workflow\/([A-Za-z0-9][A-Za-z0-9._-]*) sha256:([0-9a-f]{64})$/;

function digestOf(content: string): string {
  return createHash('sha256').update(content.replace(MARKER, '$1')).digest('hex');
}

/** The frontmatter lines that carry the marker of workflow `name`, before the file is signed. */
export function markerLines(name: string): string[] {
  return ['metadata:', `  teamai-generated: workflow/${name} sha256:`];
}

/** Fills the marker of `content`, written with `markerLines`, with the digest of the whole file. */
export function signGenerated(content: string, name: string): string {
  return content.replace(MARKER, `$1workflow/${name} sha256:${digestOf(content)}`);
}

export type Generated = { kind: 'ours'; name: string; edited: boolean } | { kind: 'theirs' };

/** Whether `content` is a skill pull generated, and whether it is still as pull wrote it. */
export function readGenerated(content: string): Generated {
  const value = MARKER.exec(content)?.[2];
  const parsed = value === undefined ? null : VALUE.exec(value);
  const name = parsed?.[1];
  if (!parsed || name === undefined) return { kind: 'theirs' };
  return { kind: 'ours', name, edited: parsed[2] !== digestOf(content) };
}

/** `readGenerated` of the SKILL.md in `skillDir`; one that cannot be read is theirs. */
export async function generatedSkillAt(skillDir: string): Promise<Generated> {
  const content = await readFileSafe(path.join(skillDir, 'SKILL.md'));
  return content === null ? { kind: 'theirs' } : readGenerated(content);
}

/** Whether `skillDir` holds nothing but a generated SKILL.md as pull wrote it, so pull may replace or remove it. */
export async function isUneditedGeneratedSkill(skillDir: string): Promise<boolean> {
  const entries = await fs.readdir(skillDir).catch(() => null);
  if (entries === null || entries.length !== 1 || entries[0] !== 'SKILL.md') return false;
  const generated = await generatedSkillAt(skillDir);
  return generated.kind === 'ours' && !generated.edited;
}
