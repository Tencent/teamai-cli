import { describe, expect, it } from 'vitest';

import { localLinkTargets } from '../utils/markdown-links.js';

describe('localLinkTargets character references', () => {
  it('decodes the named references Markdown destinations use', () => {
    expect(localLinkTargets('[guide](docs/a&amp;b.md)')).toEqual(['docs/a&b.md']);
  });

  it('keeps an unknown reference that names an Object.prototype key as written', () => {
    expect(localLinkTargets('[guide](docs/a&constructor;b.md)')).toEqual(['docs/a&constructor;b.md']);
  });
});
