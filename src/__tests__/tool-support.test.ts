import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToolSupportPage, TOOL_SUPPORT_PAGES } from '../tool-support.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('generated tool support page', () => {
  it.each(['en', 'zh-CN'] as const)('matches the tool descriptor (%s)', async (lang) => {
    // Regenerate with `npx vitest run tool-support -u` after changing `TOOLS`.
    await expect(renderToolSupportPage(lang)).toMatchFileSnapshot(path.join(ROOT, TOOL_SUPPORT_PAGES[lang]));
  });
});
