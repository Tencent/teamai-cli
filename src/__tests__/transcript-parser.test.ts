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

  it('recalled-doc-ids comment in a tool_result (non-assistant) line is detected', async () => {
    const filePath = path.join(tmpDir, 'transcript.jsonl');
    writeLine(filePath, {
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          content: 'Some tool output here.<!-- teamai:recalled-doc-ids: [doc-a, doc-b] -->',
        }],
      },
    });
    writeLine(filePath, {
      type: 'assistant',
      message: {
        content: [{
          type: 'text',
          text: 'Here is my answer with no referenced marker.',
        }],
      },
    });

    const result = await parseTranscriptForVotes(filePath);
    expect(result.recalledDocIds).toContain('doc-a');
    expect(result.recalledDocIds).toContain('doc-b');
    expect(result.recalledDocIds).toHaveLength(2);
    expect(result.referencedDocIds).toEqual([]);
  });

  it('detects recalled markers when message.content is a plain string', async () => {
    const filePath = path.join(tmpDir, 'transcript.jsonl');
    writeLine(filePath, {
      type: 'user',
      message: {
        content: 'Tool output.<!-- teamai:recalled-doc-ids: [doc-string] -->',
      },
    });

    const result = await parseTranscriptForVotes(filePath);
    expect(result.recalledDocIds).toContain('doc-string');
  });

  it('detects recalled markers in top-level toolUseResult stdout', async () => {
    const filePath = path.join(tmpDir, 'transcript.jsonl');
    writeLine(filePath, {
      type: 'user',
      toolUseResult: {
        stdout: '<!-- teamai:recalled-doc-ids: [doc-stdout] -->',
      },
    });

    const result = await parseTranscriptForVotes(filePath);
    expect(result.recalledDocIds).toContain('doc-stdout');
  });

  it('extracts Bash recall regions from tool_result content', async () => {
    const filePath = path.join(tmpDir, 'transcript.jsonl');
    writeLine(filePath, {
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          content: '--- [teamai:recall:start] ---\nFile: /path/bash-recall.md\n--- [teamai:recall:end] ---',
        }],
      },
    });

    const result = await parseTranscriptForVotes(filePath);
    expect(result.recalledDocIds).toContain('bash-recall');
  });

  it('parses case-insensitive recalled markers with smart delimiters', async () => {
    const filePath = path.join(tmpDir, 'transcript.jsonl');
    writeLine(filePath, {
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          content: '<!— TeamAI:RECALLED-DOC-IDS: [smart-recall] —>',
        }],
      },
    });

    const result = await parseTranscriptForVotes(filePath);
    expect(result.recalledDocIds).toContain('smart-recall');
  });

  it('referenced-doc-ids in a non-assistant line is NOT counted (assistant-only guard)', async () => {
    const filePath = path.join(tmpDir, 'transcript.jsonl');
    writeLine(filePath, {
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          content: 'Tool output.<!-- teamai:referenced-doc-ids: [doc-x] --><!-- teamai:recalled-doc-ids: [doc-y] -->',
        }],
      },
    });

    const result = await parseTranscriptForVotes(filePath);
    expect(result.referencedDocIds).not.toContain('doc-x');
    expect(result.referencedDocIds).toEqual([]);
    expect(result.recalledDocIds).toContain('doc-y');
  });

  it('placeholder recalled-doc-ids are filtered', async () => {
    const filePath = path.join(tmpDir, 'transcript.jsonl');
    writeLine(filePath, {
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          content: 'Some output.<!-- teamai:recalled-doc-ids: [<id1>, <id2>, ...] -->',
        }],
      },
    });
    writeLine(filePath, {
      type: 'assistant',
      message: {
        content: [{
          type: 'text',
          text: 'Here is my answer with no marker.',
        }],
      },
    });

    const result = await parseTranscriptForVotes(filePath);
    expect(result.recalledDocIds).toHaveLength(0);
  });

  it('mixed real + placeholder recalled-doc-ids keeps only real', async () => {
    const filePath = path.join(tmpDir, 'transcript.jsonl');
    writeLine(filePath, {
      type: 'user',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          content: 'Some output.<!-- teamai:recalled-doc-ids: [<id1>, real-doc-id] -->',
        }],
      },
    });
    writeLine(filePath, {
      type: 'assistant',
      message: {
        content: [{
          type: 'text',
          text: 'Here is my answer with no marker.',
        }],
      },
    });

    const result = await parseTranscriptForVotes(filePath);
    expect(result.recalledDocIds).toEqual(['real-doc-id']);
  });

  // ── 改动 1: extractReferencedDocIds 正则放宽边界测试 ──────────

  it('referenced-doc-ids: case-insensitive variant is parsed (e.g. REFERENCED-DOC-IDS)', async () => {
    const filePath = path.join(tmpDir, 'transcript.jsonl');
    writeLine(filePath, {
      type: 'assistant',
      message: {
        content: [{
          type: 'text',
          text: '<!-- Teamai:REFERENCED-DOC-IDS: [case-insensitive-doc] -->',
        }],
      },
    });

    const result = await parseTranscriptForVotes(filePath);
    expect(result.referencedDocIds).toContain('case-insensitive-doc');
  });

  it('referenced-doc-ids: em-dash closing (—>) is parsed', async () => {
    const filePath = path.join(tmpDir, 'transcript.jsonl');
    writeLine(filePath, {
      type: 'assistant',
      message: {
        content: [{
          type: 'text',
          text: '<!-- teamai:referenced-doc-ids: [em-dash-doc] —>',
        }],
      },
    });

    const result = await parseTranscriptForVotes(filePath);
    expect(result.referencedDocIds).toContain('em-dash-doc');
  });

  it('referenced-doc-ids: smart opening and closing are parsed together', async () => {
    const filePath = path.join(tmpDir, 'transcript.jsonl');
    writeLine(filePath, {
      type: 'assistant',
      message: {
        content: [{
          type: 'text',
          text: '<!— teamai:referenced-doc-ids: [smart-doc] —>',
        }],
      },
    });

    const result = await parseTranscriptForVotes(filePath);
    expect(result.referencedDocIds).toContain('smart-doc');
  });

  it('referenced-doc-ids: missing closing delimiter is NOT parsed (negative case)', async () => {
    const filePath = path.join(tmpDir, 'transcript.jsonl');
    writeLine(filePath, {
      type: 'assistant',
      message: {
        content: [{
          type: 'text',
          text: '<!-- teamai:referenced-doc-ids: [no-close-doc]',
        }],
      },
    });

    const result = await parseTranscriptForVotes(filePath);
    expect(result.referencedDocIds).toEqual([]);
  });

  it('empty referenced-doc-ids [] is treated as a valid declaration', async () => {
    const filePath = path.join(tmpDir, 'transcript.jsonl');
    writeLine(filePath, {
      type: 'assistant',
      message: {
        content: [{
          type: 'text',
          text: '<!-- teamai:referenced-doc-ids: [] -->',
        }],
      },
    });

    const result = await parseTranscriptForVotes(filePath);
    expect(result.referencedDocIds).toEqual([]);
    expect(result.hasReferencedDocIdsDeclaration).toBe(true);
  });

  it('placeholder-only referenced-doc-ids is not treated as a declaration', async () => {
    const filePath = path.join(tmpDir, 'transcript.jsonl');
    writeLine(filePath, {
      type: 'assistant',
      message: {
        content: [{
          type: 'text',
          text: '<!-- teamai:referenced-doc-ids: [<id1>, <id2>, ...] -->',
        }],
      },
    });

    const result = await parseTranscriptForVotes(filePath);
    expect(result.referencedDocIds).toEqual([]);
    expect(result.hasReferencedDocIdsDeclaration).toBe(false);
  });

  it('mixed real + placeholder referenced-doc-ids counts as a declaration', async () => {
    const filePath = path.join(tmpDir, 'transcript.jsonl');
    writeLine(filePath, {
      type: 'assistant',
      message: {
        content: [{
          type: 'text',
          text: '<!-- teamai:referenced-doc-ids: [<id1>, real-doc-id] -->',
        }],
      },
    });

    const result = await parseTranscriptForVotes(filePath);
    expect(result.referencedDocIds).toEqual(['real-doc-id']);
    expect(result.hasReferencedDocIdsDeclaration).toBe(true);
  });
});
