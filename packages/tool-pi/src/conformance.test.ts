import path from 'node:path';
import { describeFamily, fixtureText } from '@teamai/tool-testing/conformance';
import { family } from './index.js';

const fixture = (name: string): string => fixtureText(new URL(`./fixtures/${name}`, import.meta.url));

/** pi keeps a session at `<store>/--<cwd with each separator as ->--/<started at>_<id>.jsonl`, and finds it by its header's cwd. */
const piTranscript = {
  text: fixture('pi-session.jsonl'),
  place: (store: string, cwd: string, sessionId: string): string =>
    path.join(store, `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`, `2026-10-30T09-15-02-118Z_${sessionId}.jsonl`),
  userText: 'Which test runner does this repo use?',
};

describeFamily('tool-pi', family, {
  calls: {
    pi: {
      answered: { stdout: fixture('pi-print-answered.jsonl'), text: 'It uses Vitest.' },
      failed: { stdout: fixture('pi-print-failed.jsonl'), message: '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}' },
    },
    omp: {
      answered: { stdout: fixture('pi-print-answered.jsonl'), text: 'It uses Vitest.' },
      failed: { stdout: fixture('pi-print-failed.jsonl'), message: '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}' },
    },
  },
  transcripts: { pi: piTranscript, omp: piTranscript },
  // Pi counts cache reads and writes apart from input.
  tokens: { 'pi-session': { text: fixture('pi-session.jsonl'), tokens: { input: 1200, output: 80, cacheRead: 6400, cacheCreation: 512 } } },
  versions: { pi: { command: 'pi', stdout: '1.4.0', version: '1.4.0' } },
});
