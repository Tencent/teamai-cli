// -*- coding: utf-8 -*-
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { parseTranscriptForVotes } from '../transcript-parser.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-transcript-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeLine(filePath: string, entry: Record<string, unknown>): void {
  fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
}

describe('parseTranscriptForVotes', () => {
  it('returns empty for non-existent file', async () => {
    const result = await parseTranscriptForVotes(path.join(tmpDir, 'nope.jsonl'));
    expect(result.recalledDocIds).toEqual([]);
    expect(result.referencedDocIds).toEqual([]);
  });

  it('returns empty for empty file', async () => {
    const filePath = path.join(tmpDir, 'empty.jsonl');
    fs.writeFileSync(filePath, '');
    const result = await parseTranscriptForVotes(filePath);
    expect(result.recalledDocIds).toEqual([]);
    expect(result.referencedDocIds).toEqual([]);
  });

  it('extracts recalled doc IDs from recall markers', async () => {
    const filePath = path.join(tmpDir, 'transcript.jsonl');
    writeLine(filePath, {
      type: 'assistant',
      message: {
        content: [{
          type: 'text',
          text: '--- [teamai:recall:start] ---\nFile: /path/to/learnings/api-fix.md\nFile: /path/to/docs/design-overview.md\n--- [teamai:recall:end] ---',
        }],
      },
    });

    const result = await parseTranscriptForVotes(filePath);
    expect(result.recalledDocIds).toContain('api-fix');
    expect(result.recalledDocIds).toContain('design-overview');
    expect(result.recalledDocIds).toHaveLength(2);
  });

  it('extracts referenced doc IDs from HTML comment markers', async () => {
    const filePath = path.join(tmpDir, 'transcript.jsonl');
    writeLine(filePath, {
      type: 'assistant',
      message: {
        content: [{
          type: 'text',
          text: 'Here is my answer.\n\n<!-- teamai:referenced-doc-ids: [api-fix, design-overview] -->',
        }],
      },
    });

    const result = await parseTranscriptForVotes(filePath);
    expect(result.referencedDocIds).toContain('api-fix');
    expect(result.referencedDocIds).toContain('design-overview');
    expect(result.referencedDocIds).toHaveLength(2);
  });

  it('deduplicates across multiple messages', async () => {
    const filePath = path.join(tmpDir, 'transcript.jsonl');
    writeLine(filePath, {
      type: 'assistant',
      message: {
        content: [{
          type: 'text',
          text: '--- [teamai:recall:start] ---\nFile: /path/api-fix.md\n--- [teamai:recall:end] ---',
        }],
      },
    });
    writeLine(filePath, {
      type: 'assistant',
      message: {
        content: [{
          type: 'text',
          text: '--- [teamai:recall:start] ---\nFile: /path/api-fix.md\n--- [teamai:recall:end] ---',
        }],
      },
    });

    const result = await parseTranscriptForVotes(filePath);
    expect(result.recalledDocIds).toHaveLength(1);
  });

  it('ignores non-assistant entries', async () => {
    const filePath = path.join(tmpDir, 'transcript.jsonl');
    writeLine(filePath, {
      type: 'user',
      message: {
        content: [{
          type: 'text',
          text: '<!-- teamai:referenced-doc-ids: [fake-doc] -->',
        }],
      },
    });

    const result = await parseTranscriptForVotes(filePath);
    expect(result.referencedDocIds).toEqual([]);
  });

  it('handles quoted doc IDs in referenced markers', async () => {
    const filePath = path.join(tmpDir, 'transcript.jsonl');
    writeLine(filePath, {
      type: 'assistant',
      message: {
        content: [{
          type: 'text',
          text: '<!-- teamai:referenced-doc-ids: ["doc-a", \'doc-b\'] -->',
        }],
      },
    });

    const result = await parseTranscriptForVotes(filePath);
    expect(result.referencedDocIds).toContain('doc-a');
    expect(result.referencedDocIds).toContain('doc-b');
  });
});
