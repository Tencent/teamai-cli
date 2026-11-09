import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { RuleFolders } from '../resources/rule-folders.js';
import { LocalConfigSchema } from '../types.js';

/**
 * The paths `${TEAMAI_RULE_DIR}` renders to (#1787), on every platform: forward slashes, Windows included, and a home
 * path with spaces and non-ASCII characters kept as it is. In the Windows CI job's list.
 */
describe('rule folder paths', () => {
  const home = path.join(os.tmpdir(), 'Jörg Müller 用户');
  const rule = { name: 'fe/api-style', type: 'rules', sourcePath: path.join(home, 'team', 'rules', 'fe', 'api-style', 'RULE.md'), relativePath: 'rules/fe/api-style/RULE.md', folder: true } as const;
  const config = (extra: Record<string, string>) => ({
    ...LocalConfigSchema.parse({ repo: { localPath: path.join(home, 'team'), remote: '' }, username: 'u', ...extra }),
    dataHome: path.join(home, '.teamai'),
  });

  it('names the data home by its absolute path, with forward slashes', () => {
    const rendered = RuleFolders.render('read ${TEAMAI_RULE_DIR}/checklist.md', { localConfig: config({ scope: 'user' }), rule, tool: 'claude' });

    expect(rendered).toBe(`read ${path.join(home, '.teamai', 'rules', 'fe', 'api-style').split(path.sep).join('/')}/checklist.md`);
    expect(rendered).not.toContain('\\');
    expect(path.isAbsolute(rendered.slice('read '.length))).toBe(true);
  });

  it('names the worktree copy relative to the project root, with forward slashes', () => {
    const localConfig = config({ scope: 'project', projectRoot: path.join(home, 'my project') });

    expect(RuleFolders.render('read ${TEAMAI_RULE_DIR}/checklist.md', { localConfig, rule, tool: 'codex' }))
      .toBe('read .teamai/delivered/rules/fe/api-style/checklist.md');
  });
});
