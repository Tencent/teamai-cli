import { describe, it, expect } from 'vitest';
import { resolveRoute, DEFAULT_ROUTES, type RouteName } from '../local-agent.js';

describe('local-agent: resolveRoute – path mapping', () => {
  it('returns the default path when no overrides are configured', () => {
    for (const name of Object.keys(DEFAULT_ROUTES) as RouteName[]) {
      expect(resolveRoute({}, name)).toBe(DEFAULT_ROUTES[name]);
      expect(resolveRoute({ routes: {} }, name)).toBe(DEFAULT_ROUTES[name]);
    }
  });

  it('applies an override for a single route, leaving others at their defaults', () => {
    const config = { routes: { getConfig: '/api/plugins/config' } };
    expect(resolveRoute(config, 'getConfig')).toBe('/api/plugins/config');
    expect(resolveRoute(config, 'sync')).toBe(DEFAULT_ROUTES.sync);
    expect(resolveRoute(config, 'report')).toBe(DEFAULT_ROUTES.report);
  });

  it('supports overriding every route independently', () => {
    const config = {
      routes: {
        userGroups: '/v2/groups',
        report: '/v2/report',
        sync: '/v2/sync',
        ack: '/v2/ack',
        getConfig: '/v2/config',
      },
    };
    expect(resolveRoute(config, 'userGroups')).toBe('/v2/groups');
    expect(resolveRoute(config, 'report')).toBe('/v2/report');
    expect(resolveRoute(config, 'sync')).toBe('/v2/sync');
    expect(resolveRoute(config, 'ack')).toBe('/v2/ack');
    expect(resolveRoute(config, 'getConfig')).toBe('/v2/config');
  });

  it('prepends a leading slash when the override omits it', () => {
    expect(resolveRoute({ routes: { sync: 'custom/sync' } }, 'sync')).toBe('/custom/sync');
  });

  it('trims surrounding whitespace from the override', () => {
    expect(resolveRoute({ routes: { sync: '  /custom/sync  ' } }, 'sync')).toBe('/custom/sync');
  });

  it('ignores a blank/whitespace-only override and falls back to the default', () => {
    expect(resolveRoute({ routes: { sync: '' } }, 'sync')).toBe(DEFAULT_ROUTES.sync);
    expect(resolveRoute({ routes: { sync: '   ' } }, 'sync')).toBe(DEFAULT_ROUTES.sync);
  });
});
