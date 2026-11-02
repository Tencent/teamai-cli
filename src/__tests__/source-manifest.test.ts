import { describe, expect, it } from 'vitest';
import { SourceManifestSchema } from '../wiki-engine/code-knowledge/code-collector.js';

describe('SourceManifestSchema', () => {
  it('keeps the ingested MRs the next import carries forward when one entry is malformed', () => {
    const manifest = SourceManifestSchema.parse({
      ingestedMrs: [{ url: 'https://git.example.com/team/app/-/merge_requests/1', at: '2026-10-01T00:00:00.000Z' }, { url: 2 }],
    });

    expect(manifest.ingestedMrs).toEqual([{ url: 'https://git.example.com/team/app/-/merge_requests/1', at: '2026-10-01T00:00:00.000Z' }]);
  });
});
