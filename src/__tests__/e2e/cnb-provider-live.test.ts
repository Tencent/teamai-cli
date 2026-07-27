import { describe, it, expect } from 'vitest';
import { cnbIsAuthenticated, cnbWhoami } from '../../providers/cnb/cnb-cli.js';

/**
 * Live, read-only smoke test for CNB auth against a real cnb.cool account.
 *
 * Opt-in: skipped unless CNB_TOKEN is set, so normal CI (no CNB secret) never
 * runs it. Intentionally read-only — it does NOT create repos/PRs, because some
 * CNB namespaces block resource deletion via the Open API (root-group rules), so
 * a create/delete test would leave undeletable orphans. The full mutating flow
 * (create → clone → push → open-PR) was verified manually; see the PR notes.
 */
const HAS_CNB = Boolean(process.env.CNB_TOKEN);

describe('CNB provider (live cnb.cool)', () => {
  it.skipIf(!HAS_CNB)('authenticates via env token and resolves the account username', () => {
    expect(cnbIsAuthenticated()).toBe(true);
    const user = cnbWhoami();
    expect(typeof user).toBe('string');
    expect((user ?? '').length).toBeGreaterThan(0);
  });
});
