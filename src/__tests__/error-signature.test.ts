import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';
import {
  normalizeErrorSignature,
  extractErrorSignatures,
  matchErrorSignatures,
} from '../utils/error-signature.js';
import { buildIndex, loadIndex } from '../utils/search-index.js';

// ---------------------------------------------------------------------------
// error-signature: unit tests
// ---------------------------------------------------------------------------

describe('normalizeErrorSignature', () => {
  // ── Defect 1 regression: pure decimal numbers must NOT become <HASH> ──────
  it('pure decimal number becomes <n>, not <HASH>', () => {
    const sig = normalizeErrorSignature('size 8388608');
    expect(sig).toContain('<n>');
    expect(sig).not.toContain('<hash>');
  });

  it('de0b3aa (hex string with letters) becomes <hash>', () => {
    const sig = normalizeErrorSignature('de0b3aa');
    expect(sig).toBe('<hash>');
  });

  it('abc1234 (hex string with letters) becomes <hash>', () => {
    const sig = normalizeErrorSignature('abc1234');
    expect(sig).toBe('<hash>');
  });

  // ── Defect 2 regression: quoted identifiers must NOT be normalised ────────
  it('KeyError glm_moe_dsa and glm_moe_v2 produce different signatures', () => {
    const sig1 = normalizeErrorSignature("KeyError: 'glm_moe_dsa'");
    const sig2 = normalizeErrorSignature("KeyError: 'glm_moe_v2'");
    expect(sig1).not.toBe(sig2);
  });

  // ── Core use-case: same failure reported with different concrete values ────
  it('shape error with different dimensions and sizes collapse to same signature', () => {
    const raw1 = "RuntimeError: shape '[2045, -1, 64]' is invalid for input of size 8388608";
    const raw2 = "RuntimeError: shape '[2048, -1, 64]' is invalid for input of size 8368128";
    const sig1 = normalizeErrorSignature(raw1);
    const sig2 = normalizeErrorSignature(raw2);
    expect(sig1).toBe(sig2);
    // Confirm the signature is non-empty and lowercased
    expect(sig1.length).toBeGreaterThan(0);
    expect(sig1).toBe(sig1.toLowerCase());
  });

  it('ValueError with 64 and 256 block sizes collapse to same signature', () => {
    const raw1 = 'ValueError: Weight output_partition_size = 64 is not divisible by weight quantization block_n = 128.';
    const raw2 = 'ValueError: Weight output_partition_size = 256 is not divisible by weight quantization block_n = 128.';
    const sig1 = normalizeErrorSignature(raw1);
    const sig2 = normalizeErrorSignature(raw2);
    expect(sig1).toBe(sig2);
  });

  it('RuntimeError: Gloo connectFullMesh failed and connectTimeout failed are different', () => {
    const sig1 = normalizeErrorSignature('RuntimeError: Gloo connectFullMesh failed');
    const sig2 = normalizeErrorSignature('RuntimeError: Gloo connectTimeout failed');
    expect(sig1).not.toBe(sig2);
  });

  // ── Path normalisation ────────────────────────────────────────────────────
  it('file path in error message is replaced with <PATH>', () => {
    const raw = 'RuntimeError: Assertion error (csrc/apis/../jit_kernels/impls/../../jit/handle.hpp:126)';
    const sig = normalizeErrorSignature(raw);
    expect(sig).toContain('<path>');
    // The number (126) should also be normalised
    expect(sig).not.toMatch(/\b126\b/);
    // A relative path's leading segment is absorbed too, so no 'csrc' residue
    // is left dangling in front of the placeholder.
    expect(sig).not.toContain('csrc');
  });

  it('URL is replaced with <URL> and leaves no scheme residue', () => {
    const sig = normalizeErrorSignature('RuntimeError: fetch https://example.com/a/b/c failed');
    expect(sig).toContain('<url>');
    expect(sig).not.toContain('https:');
    expect(sig).not.toContain('<path>');
  });

  it('treats short slash expressions symmetrically — neither a/b nor c/d/e is a path', () => {
    // Both are below the 3-segment threshold, so neither may be rewritten.
    // Asymmetric handling would make the same error yield different signatures
    // depending on incidental prose.
    const sig = normalizeErrorSignature('ValueError: ratio a/b and c/d/e differ');
    expect(sig).toContain('a/b');
    expect(sig).toContain('c/d/e');
    expect(sig).not.toContain('<path>');
  });

  it('is idempotent — re-normalising an already normalised signature is stable', () => {
    const raw =
      'RuntimeError: at /a/b/c/d see https://x.io/p/q hash de0b3aa ver 12.9.1 num 8388608';
    const once = normalizeErrorSignature(raw);
    expect(normalizeErrorSignature(once)).toBe(once);
  });

  // ── Version numbers ───────────────────────────────────────────────────────
  it('CUDA version string becomes <VER>', () => {
    const sig = normalizeErrorSignature('CUDA 12.9.1');
    expect(sig).toContain('<ver>');
    // Should not produce three separate <N> tokens for "12", "9", "1"
    expect(sig).not.toMatch(/<n>\.<n>\.<n>/);
  });

  // ── Edge cases ────────────────────────────────────────────────────────────
  it('empty string returns empty string', () => {
    expect(normalizeErrorSignature('')).toBe('');
  });

  it('whitespace-only string returns empty string', () => {
    expect(normalizeErrorSignature('   \t\n  ')).toBe('');
  });
});

// ---------------------------------------------------------------------------

describe('extractErrorSignatures', () => {
  it('extracts error signatures from a markdown body with multiple errors', () => {
    // Use plain error lines, not heading lines, to avoid ambiguity
    const body = [
      'We saw this when running inference:',
      "RuntimeError: shape '[2045, -1, 64]' is invalid for input of size 8388608",
      '',
      'And also:',
      'ValueError: Weight output_partition_size = 64 is not divisible by weight quantization block_n = 128.',
    ].join('\n');
    const sigs = extractErrorSignatures(body);
    expect(sigs.length).toBe(2);
    // Both should be normalised (lowercased)
    expect(sigs.every((s) => s === s.toLowerCase())).toBe(true);
  });

  it('deduplicates identical signatures appearing multiple times', () => {
    const body = `
RuntimeError: Gloo connectFullMesh failed
Some text in between.
RuntimeError: Gloo connectFullMesh failed
`;
    const sigs = extractErrorSignatures(body);
    expect(sigs.length).toBe(1);
  });

  it('respects EXTRACT_LIMIT (8) and returns at most 8 distinct signatures', () => {
    // Construct 12 different errors
    const errorLines = Array.from({ length: 12 }, (_, i) =>
      `RuntimeError: unique error message number ${i + 1} occurred in the system`,
    ).join('\n');

    const sigs = extractErrorSignatures(errorLines);
    expect(sigs.length).toBeLessThanOrEqual(8);
    expect(sigs.length).toBeGreaterThan(0);
  });

  it('returns empty array for plain text with no error lines', () => {
    const body = 'This is a normal document with no exceptions or errors of the RuntimeError variety.';
    const sigs = extractErrorSignatures(body);
    // "no error lines" means no colon-delimited exception class
    // The word "errors" alone won't match because we need "Error:" or "Exception:" pattern
    expect(sigs).toEqual([]);
  });

  it('returns empty array for empty body', () => {
    expect(extractErrorSignatures('')).toEqual([]);
  });

  it('returns signatures in first-seen order', () => {
    const body = `
RuntimeError: first error occurred
ValueError: second error happened
`;
    const sigs = extractErrorSignatures(body);
    expect(sigs.length).toBe(2);
    // First signature should correspond to RuntimeError
    expect(sigs[0]).toContain('runtimeerror');
    expect(sigs[1]).toContain('valueerror');
  });
});

// ---------------------------------------------------------------------------

describe('matchErrorSignatures', () => {
  // Build the sigIndex using normalizeErrorSignature so keys always match
  // exactly what the lookup would produce at query time.
  const glooSig = normalizeErrorSignature('RuntimeError: Gloo connectFullMesh failed');
  const partitionSig = normalizeErrorSignature(
    'ValueError: Weight output_partition_size = 64 is not divisible by weight quantization block_n = 128.',
  );

  const sigIndex: Record<string, string[]> = {
    [glooSig]: ['gloo-fix.md'],
    [partitionSig]: ['partition-fix.md'],
  };

  it('returns matching filenames when query contains a known error', () => {
    const query = 'RuntimeError: Gloo connectFullMesh failed';
    const matches = matchErrorSignatures(query, sigIndex);
    expect(matches).toContain('gloo-fix.md');
  });

  it('returns matching filenames when query contains error with different numbers (same signature)', () => {
    // Different numbers but same structure → same normalised signature
    const query = 'ValueError: Weight output_partition_size = 256 is not divisible by weight quantization block_n = 128.';
    const matches = matchErrorSignatures(query, sigIndex);
    expect(matches).toContain('partition-fix.md');
  });

  it('returns empty array when query error is not in index', () => {
    const query = 'RuntimeError: completely unknown error message nobody has seen';
    const matches = matchErrorSignatures(query, sigIndex);
    expect(matches).toEqual([]);
  });

  it('returns empty array when query has no error-like content', () => {
    const query = 'how do I configure the learning rate for distributed training?';
    const matches = matchErrorSignatures(query, sigIndex);
    expect(matches).toEqual([]);
  });

  it('deduplicates results when multiple signatures map to the same file', () => {
    const sig1 = normalizeErrorSignature('RuntimeError: first error happened');
    const sig2 = normalizeErrorSignature('ValueError: second error happened');
    const multiIndex: Record<string, string[]> = {
      [sig1]: ['shared.md'],
      [sig2]: ['shared.md'],
    };
    const query = 'RuntimeError: first error happened\nValueError: second error happened';
    const matches = matchErrorSignatures(query, multiIndex);
    const uniqueMatches = [...new Set(matches)];
    expect(matches.length).toBe(uniqueMatches.length);
    expect(matches).toContain('shared.md');
  });

  it('returns empty array when sigIndex is empty', () => {
    const query = 'RuntimeError: some error message here';
    const matches = matchErrorSignatures(query, {});
    expect(matches).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildIndex level: assert errorSignatures populated and df isolation
// ---------------------------------------------------------------------------

let tmpDir: string;
let indexPath: string;

beforeEach(async () => {
  tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-sig-test-'));
  indexPath = path.join(tmpDir, 'search-index.json');
});

afterEach(async () => {
  await fse.remove(tmpDir);
});

describe('buildIndex error signature integration', () => {
  it('errorSignatures field is populated when learnings contain error lines', async () => {
    const learningsDir = path.join(tmpDir, 'learnings');
    await fse.ensureDir(learningsDir);

    await fse.writeFile(
      path.join(learningsDir, 'gloo-fix.md'),
      '---\ntitle: "Gloo training fix"\ntags: [troubleshooting]\n---\n' +
      'We saw: RuntimeError: Gloo connectFullMesh failed during distributed training.\n',
    );

    await buildIndex({ learningsDir, indexPath });
    const index = await loadIndex(indexPath);

    expect(index).not.toBeNull();
    expect(index!.errorSignatures).toBeDefined();
    expect(Object.keys(index!.errorSignatures!).length).toBeGreaterThan(0);

    // At least one signature should map to gloo-fix.md
    const allFiles = Object.values(index!.errorSignatures!).flat();
    expect(allFiles).toContain('gloo-fix.md');
  });

  it('error signature strings do NOT appear in entry.tokens', async () => {
    const learningsDir = path.join(tmpDir, 'learnings');
    await fse.ensureDir(learningsDir);

    await fse.writeFile(
      path.join(learningsDir, 'error-doc.md'),
      '---\ntitle: "Error doc"\ntags: [troubleshooting]\n---\n' +
      'RuntimeError: Gloo connectFullMesh failed when training.\n',
    );

    await buildIndex({ learningsDir, indexPath });
    const index = await loadIndex(indexPath);

    expect(index).not.toBeNull();
    const entry = index!.entries.find((e) => e.filename === 'error-doc.md');
    expect(entry).toBeDefined();

    // The normalised signature must not appear as a token.
    // Signatures look like "runtimeerror: gloo connectfullmesh failed" (lowercased full line),
    // which the tokenizer would split differently. But we want to assert that the
    // raw signature string was never inserted into tokens.
    const tokenSet = new Set(entry!.tokens);
    const sigs = Object.keys(index!.errorSignatures ?? {});
    for (const sig of sigs) {
      expect(tokenSet.has(sig)).toBe(false);
    }
  });

  it('df is not affected by error signatures — a plain word has the same df with or without error content', async () => {
    const learningsDir1 = path.join(tmpDir, 'learnings1');
    const learningsDir2 = path.join(tmpDir, 'learnings2');
    const indexPath1 = path.join(tmpDir, 'index1.json');
    const indexPath2 = path.join(tmpDir, 'index2.json');
    await fse.ensureDir(learningsDir1);
    await fse.ensureDir(learningsDir2);

    // Both documents share the same prose; doc2 additionally carries error lines.
    //
    // Design note (why NOT whole-map df equality):
    //   Asserting df['timeout']==1 in both maps does NOT detect the PR-278
    //   failure mode, since 'timeout' is not a signature token — it stays 1 even
    //   if every signature leaks into tokens.
    //   Whole-map equality does not work either: an error line's *ordinary*
    //   words ('divisible', 'runtimeerror', '2045', ...) legitimately enter
    //   tokens and df, because the raw body text is tokenized for BM25 as it
    //   always was. That is by design, not leakage.
    //   The real invariant is therefore: no *normalised placeholder* ever
    //   reaches tokens or df. Placeholders exist only inside errorSignatures.
    const sharedProse =
      '---\ntitle: "timeout guide"\ntags: [api]\n---\n' +
      'Handle timeout carefully.\n';

    await fse.writeFile(path.join(learningsDir1, 'doc.md'), sharedProse);

    await fse.writeFile(
      path.join(learningsDir2, 'doc.md'),
      sharedProse +
      'RuntimeError: Gloo connectFullMesh failed.\n' +
      'ValueError: Weight output_partition_size = 64 is not divisible by block_n = 128.\n' +
      "RuntimeError: shape '[2045, -1, 64]' is invalid for input of size 8388608.\n" +
      'RuntimeError: Assertion error (csrc/apis/../jit/handle.hpp:126):\n',
    );

    await buildIndex({ learningsDir: learningsDir1, indexPath: indexPath1 });
    await buildIndex({ learningsDir: learningsDir2, indexPath: indexPath2 });

    const index1 = await loadIndex(indexPath1);
    const index2 = await loadIndex(indexPath2);

    expect(index1).not.toBeNull();
    expect(index2).not.toBeNull();

    const PLACEHOLDERS = ['<n>', '<path>', '<hash>', '<hex>', '<ver>', '<url>'];

    // No placeholder may appear as (or inside) a df key.
    for (const key of Object.keys(index2!.df ?? {})) {
      for (const ph of PLACEHOLDERS) {
        expect(key).not.toContain(ph);
      }
    }

    // No placeholder may appear in entry.tokens.
    const entry2 = index2!.entries.find((e) => e.filename === 'doc.md');
    expect(entry2).toBeDefined();
    expect(entry2!.tokens.some((t) => PLACEHOLDERS.some((ph) => t.includes(ph)))).toBe(false);

    // The df of a word untouched by the error lines stays put, confirming the
    // error content did not perturb pre-existing entries' weighting.
    expect(index2!.df?.['timeout']).toBe(index1!.df?.['timeout']);

    // Signatures — which DO contain placeholders — are present only in index2.
    expect(Object.keys(index1!.errorSignatures ?? {}).length).toBe(0);
    const sigs2 = Object.keys(index2!.errorSignatures ?? {});
    expect(sigs2.length).toBeGreaterThan(0);
    expect(sigs2.some((s) => PLACEHOLDERS.some((ph) => s.includes(ph)))).toBe(true);
  });
});
