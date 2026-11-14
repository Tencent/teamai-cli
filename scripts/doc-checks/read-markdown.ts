import { readFileSync } from 'node:fs';

/** Compare and parse Markdown independently of Git's checkout line endings. */
export function readMarkdown(file: string): string {
  return readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}
