import fs from 'node:fs';
import path from 'node:path';
import { check } from '../doc-check.js';

// A UTF-8 sequence read as Latin-1 and encoded again turns into its lead, one of Â..ô, followed by as many characters of
// U+0080..U+00BF as the lead takes (`…` becomes `â\u0080¦`), so Latin-1 text such as «café» does not match. An edit that
// wrote non-ASCII text without its encoding, such as perl without -CSD, leaves it.
const ENCODED_TWICE = /[Â-ß][\u0080-¿]|[à-ï][\u0080-¿]{2}|[ð-ô][\u0080-¿]{3}/u;

// Every file members and agents read, but images, whose bytes are no text.
const ROOTS = ['docs', 'skill-data'];
const BINARY = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico']);

function filesUnder(root: string, dir: string): string[] {
  if (!fs.existsSync(path.join(root, dir))) return [];

  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.posix.join(dir, entry.name);

    if (entry.isDirectory()) return filesUnder(root, rel);

    return entry.isFile() && !BINARY.has(path.extname(entry.name).toLowerCase()) ? [rel] : [];
  });
}

await check('holds no UTF-8 encoded twice under docs/ and skill-data/', () => {
  const root = process.cwd();
  const files = ROOTS.flatMap((dir) => filesUnder(root, dir));

  if (files.length === 0) throw new Error(`No file found under ${ROOTS.join(' or ')}: run the check from the repository root.`);

  const found = files.flatMap((file) => fs.readFileSync(path.join(root, file), 'utf8').split('\n')
    .flatMap((line, index) => (ENCODED_TWICE.test(line) ? [`${file}:${index + 1}: ${JSON.stringify(line.match(ENCODED_TWICE)?.[0])}`] : [])));

  if (found.length > 0) throw new Error(`${found.join('\n')}\nThese lines hold UTF-8 that was encoded a second time. Write the characters again as UTF-8 (perl needs -Mutf8 -CSD).`);
});
