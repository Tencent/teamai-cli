import { describe, expect, it } from 'vitest';
import { asKnowledge, readDocument, sourceResources, writeDocument } from '../documents/okf.js';

describe('OKF documents', () => {
  it('preserves unknown types, fields, comments and body-only edits', () => {
    const source = '---\r\ntype: Custom\r\n# retained comment\r\nx-vendor: {flag: true}\r\n---\r\nOld body';
    const parsed = readDocument(source);
    expect(parsed.diagnostics).toEqual([]);
    expect(writeDocument(parsed, parsed.data, 'New body')).toBe(source.replace('Old body', 'New body'));
    const changed = writeDocument(parsed, { ...parsed.data, title: 'New title' });
    expect(changed).toContain('# retained comment');
    expect(readDocument(changed).data).toMatchObject({ 'x-vendor': { flag: true }, title: 'New title' });
  });

  it('diagnoses invalid metadata without losing the body', () => {
    for (const content of ['plain text', '---\ntitle: hi\n---\nBody', '---\ntype: [\n---\nBody', '---\ntype: One\ntype: Two\n---\nBody']) {
      expect(readDocument(content).diagnostics.length).toBeGreaterThan(0);
    }
    expect(readDocument('---\ntype: [\n---\nBody').body).toBe('Body');
    expect(() => asKnowledge('---\ntype: [\n---\nBody', 'Reference')).toThrow('malformed');
  });

  it('handles reserved indexes and log dates without concept metadata', () => {
    expect(readDocument('# Index', 'index.md').diagnostics).toEqual([]);
    expect(readDocument('---\nokf_version: "0.2"\n---\n# Index', 'index.md').diagnostics).toEqual([]);
    expect(readDocument('---\nokf_version: "0.2"\n---\n# Index', 'nested/index.md').diagnostics[0]?.code).toBe('OKF_RESERVED');
    expect(readDocument('## 2026-02-30\n* Update', 'log.md').diagnostics[0]?.code).toBe('OKF_LOG_DATE');
    expect(readDocument('## 2026-10-30\n* Update', 'log.md').diagnostics).toEqual([]);
    expect(asKnowledge('# Index', 'Reference', 'index.md')).toBe('# Index');
  });

  it('migrates known knowledge without inventing verification or deleting legacy evidence', () => {
    const old = '---\ntitle: Example\nsource: src/a.ts:12\nsources: [src/b.ts]\nstatus: stale\nreviewState: accepted\nconfidence: EXTRACTED\ncustom: keep\n---\n# Body\n';
    const result = asKnowledge(old, 'Code Reference');
    const parsed = readDocument(result);
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.data).toMatchObject({ type: 'Code Reference', sources: [{ resource: 'src/b.ts' }], source: 'src/a.ts:12', status: 'stable', legacy_status: 'stale', reviewState: 'accepted', custom: 'keep' });
    expect(parsed.data.verified).toBeUndefined();
    expect(sourceResources(parsed.data)).toEqual(['src/b.ts', 'src/a.ts:12']);
    expect(asKnowledge(result, 'Reference')).toBe(result);
  });

  it('does not reject unknown fields or broken links but diagnoses invalid known families', () => {
    expect(readDocument('---\ntype: Future\nfuture: yes\n---\n[Later](missing.md)').diagnostics).toEqual([]);
    const parsed = readDocument('---\ntype: Reference\nsources: [legacy]\nverified: {by: human:alice, at: yesterday}\nstale_after: 2026-10-30\n---\nBody');
    expect(parsed.diagnostics.map((entry) => entry.code)).toEqual(['OKF_SOURCES', 'OKF_TIMESTAMP', 'OKF_EVENT']);
    expect(parsed.body).toBe('Body');
  });
});


it('creates block YAML that remains valid when a producer adds provenance', () => {
  const created = asKnowledge('A lesson\n', 'Learning');
  expect(created).toBe('---\ntype: Learning\n---\nA lesson\n');
  const doc = readDocument(created);
  expect(readDocument(writeDocument(doc, { ...doc.data, session: { platform: 'codex', sessionId: 'session' } })).diagnostics).toEqual([]);
});
