import fs from 'node:fs';
import path from 'node:path';
import type { Nodes } from 'mdast';
import { decodeNamedCharacterReference } from 'decode-named-character-reference';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { readMarkdown } from './read-markdown.js';

const root = process.cwd();

function markdownFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);

    return entry.isDirectory() ? markdownFiles(file) : entry.name.endsWith('.md') ? [file] : [];
  });
}

function* nodes(node: Nodes): Generator<Nodes> {
  yield node;

  if ('children' in node) {
    for (const child of node.children) yield* nodes(child);
  }
}

function headingText(node: Nodes): string {
  if ('children' in node) return node.children.map(headingText).join('');

  if (node.type === 'image' || node.type === 'imageReference') return node.alt ?? '';

  if (node.type === 'break') return ' ';

  if (node.type === 'html') return /^<tool>$/i.test(node.value) ? 'tool' : '';

  return 'value' in node ? node.value : '';
}

function slug(text: string): string {
  return text.trim().toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

function decodeEntities(value: string): string {
  return value.replace(/&(#(?:\d{1,7}|x[\da-f]{1,6})|[\da-z]{1,31});/gi, (reference, body: string) => {
    if (body[0] !== '#') return decodeNamedCharacterReference(body) || reference;
    const hex = body[1]?.toLowerCase() === 'x';
    const codePoint = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);

    return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '\uFFFD';
  });
}

function readDocument(file: string) {
  const headings = new Set<string>();
  const explicitAnchors = new Set<string>();
  const definitions = new Map<string, string>();
  const links: { line: number; url?: string; reference?: string }[] = [];

  for (const node of nodes(fromMarkdown(readMarkdown(file)))) {
    if (node.type === 'heading') {
      const base = slug(headingText(node));
      let id = base;

      for (let suffix = 1; headings.has(id); suffix += 1) id = `${base}-${suffix}`;
      headings.add(id);
    } else if (node.type === 'html') {
      const html = node.value.replace(/<!--[\s\S]*?-->/g, '');

      for (const tag of html.matchAll(/<a\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)) {
        for (const match of tag[0].matchAll(/(?:^|\s)(?:id|name)\s*=\s*(?:(["'])(.*?)\1|([^\s>]+))/gi)) {
          const id = match[2] ?? match[3];

          if (id) explicitAnchors.add(decodeEntities(id));
        }
      }
    } else if (node.type === 'definition') {
      if (!definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
    } else if (node.type === 'link' && node.position) {
      links.push({ line: node.position.start.line, url: node.url });
    } else if (node.type === 'linkReference' && node.position) {
      links.push({ line: node.position.start.line, reference: node.identifier });
    }
  }

  return { headings, explicitAnchors, definitions, links };
}

const files = [
  ...fs.readdirSync(root).filter((name) => /^README.*\.md$/i.test(name)).map((name) => path.join(root, name)),
  ...markdownFiles(path.join(root, 'docs')),
  ...markdownFiles(path.join(root, 'skill-data')),
];

const cache = new Map<string, ReturnType<typeof readDocument>>();

function document(file: string): ReturnType<typeof readDocument> {
  const cached = cache.get(file);

  if (cached) return cached;
  const parsed = readDocument(file);
  cache.set(file, parsed);

  return parsed;
}

for (const file of files) {
  const { definitions, links } = document(file);

  for (const { line, url, reference } of links) {
    const link = url ?? definitions.get(reference ?? '');

    if (!link || /^[a-z][a-z\d+.-]*:/i.test(link) || link.startsWith('//') || link.includes('{')) continue;

    const hash = link.indexOf('#');

    if (hash < 0 || hash === link.length - 1) continue;
    const encodedRelative = link.slice(0, hash);
    let relative = encodedRelative;

    try {
      relative = decodeURIComponent(encodedRelative);
    } catch {
      // Leave an invalid path encoded so it cannot resolve to an unrelated file.
    }

    const target = path.resolve(path.dirname(file), relative || path.basename(file));

    if (!target.endsWith('.md') || !fs.existsSync(target)) continue;

    const fragment = link.slice(hash + 1);
    let anchor = fragment;

    try {
      anchor = decodeURIComponent(fragment);
    } catch {
      // Report an invalid fragment as a broken link without stopping the remaining checks.
    }

    const { headings, explicitAnchors } = document(target);

    if (!headings.has(anchor.toLowerCase()) && !explicitAnchors.has(anchor)) {
      console.error(`${path.relative(root, file).split(path.sep).join('/')}:${line} links ${link}, which has no heading for it.`);
      process.exitCode = 1;
    }
  }
}
