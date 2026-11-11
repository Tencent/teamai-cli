import fs from 'node:fs';
import path from 'node:path';

export const GLOSSARY_PATH = 'docs/dev/glossary.md';

/** The quoted spellings on the glossary's `_Avoid_:` lines: the ones that are always wrong. */
export function avoidSpellings(root: string): string[] {
  const text = fs.readFileSync(path.join(root, GLOSSARY_PATH), 'utf8');
  const spellings = new Set<string>();

  for (const line of text.split('\n')) {
    if (!line.startsWith('_Avoid_:')) continue;

    for (const match of line.matchAll(/"([^"]+)"/g)) spellings.add(match[1]);
  }

  return [...spellings].sort();
}

function proseFiles(root: string): string[] {
  const files: string[] = [];

  const walk = (dir: string): void => {
    if (!fs.existsSync(path.join(root, dir))) return;

    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, entry.name);

      if (entry.isDirectory()) walk(rel);
      else if (/\.(md|ya?ml)$/.test(entry.name) && rel !== GLOSSARY_PATH) files.push(rel);
    }
  };

  // The docs, and every resource teamai ships: what members and agents read.
  for (const dir of ['docs', 'skill-data', 'skills', 'agents', 'rules', 'hooks', 'workflows', 'scorers']) walk(dir);

  for (const name of fs.readdirSync(root)) if (/^(README.*|AGENTS)\.md$/.test(name)) files.push(name);

  if (fs.existsSync(path.join(root, '.github/CONTRIBUTING.md'))) files.push('.github/CONTRIBUTING.md');

  return files.sort();
}

/** Prose only: code blocks, inline code, HTML tags and link targets name paths and values, not concepts. */
function prose(text: string): string {
  return text
    .replace(/^[ \t]*(```|~~~)[\s\S]*?^[ \t]*\1/gm, '')
    .replace(/`[^`\n]*`/g, '')
    .replace(/<[^>\n]+>/g, '')
    .replace(/\]\([^)]*\)/g, ']');
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Each prose use of a quoted Avoid spelling, counted per file. */
export function findAvoidSpellings(root: string) {
  const files = proseFiles(root).map((file) => ({ file, text: prose(fs.readFileSync(path.join(root, file), 'utf8')) }));

  return avoidSpellings(root).flatMap((spelling) => {
    const pattern = new RegExp(`\\b${escape(spelling).replace(/ /g, '[\\s-]+')}s?\\b`, 'gi');

    return files
      .map(({ file, text }) => ({ spelling, file, count: text.match(pattern)?.length ?? 0 }))
      .filter(({ count }) => count > 0);
  });
}
