import fs from 'node:fs';
import path from 'node:path';
import { readMarkdown } from './read-markdown.js';

const root = process.cwd();

function markdownFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);

    return entry.isDirectory() ? markdownFiles(file) : entry.name.endsWith('.md') ? [file] : [];
  });
}

function slug(text: string): string {
  return text.toLowerCase()
    .replace(/<\/[^>]+>/g, '')
    .replace(/<([^>\s/]+)>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[`*~]/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

function anchors(file: string): Set<string> {
  const seen = new Map<string, number>();
  const result = new Set<string>();

  for (const match of readMarkdown(file).matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
    const base = slug(match[1] ?? '');
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    result.add(count ? `${base}-${count}` : base);
  }

  for (const match of readMarkdown(file).matchAll(/<a\b[^>]*\b(?:id|name)\s*=\s*(?:(["'])(.*?)\1|([^\s>]+))[^>]*>/gi)) {
    const explicit = match[2] ?? match[3];

    if (explicit) result.add(explicit.toLowerCase());
  }

  return result;
}

const files = [
  ...fs.readdirSync(root).filter((name) => /^README.*\.md$/i.test(name)).map((name) => path.join(root, name)),
  ...markdownFiles(path.join(root, 'docs')),
  ...markdownFiles(path.join(root, 'skill-data')),
];

const cache = new Map<string, Set<string>>();

for (const file of files) {
  const text = readMarkdown(file);

  for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+#[^)\s]+)\)/g)) {
    const link = match[1] ?? '';

    if (/^[a-z]+:/i.test(link) || link.includes('{')) continue;

    const [relative, rawFragment] = link.split('#', 2);
    const target = path.resolve(path.dirname(file), relative || path.basename(file));

    if (!target.endsWith('.md') || !fs.existsSync(target)) continue;

    const fragment = decodeURIComponent(rawFragment ?? '').toLowerCase();
    const targetAnchors = cache.get(target) ?? anchors(target);
    cache.set(target, targetAnchors);

    if (!targetAnchors.has(fragment)) {
      const line = text.slice(0, match.index).split('\n').length;
      console.error(`${path.relative(root, file).split(path.sep).join('/')}:${line} links ${link}, which has no heading for it.`);
      process.exitCode = 1;
    }
  }
}
