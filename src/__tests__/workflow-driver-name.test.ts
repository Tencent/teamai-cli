import { describe, expect, it } from 'vitest';
import { parseDriver } from '../workflow/driver-name.js';

describe('parseDriver', () => {
  it.each(['local', 'skill', 'none'] as const)('reads %s as the driver of that name', (name) => {
    expect(parseDriver(name)).toEqual({ ok: true, driver: name });
  });

  it.each(['acme', 'acme-sandbox', 'Team_2.v1', '9lives'])('reads %s as a driver definition outside teamai', (name) => {
    expect(parseDriver(name)).toEqual({ ok: true, driver: { external: name } });
  });

  it('refuses fleet, which teamai reserves', () => {
    expect(parseDriver('fleet')).toEqual({ ok: false, reason: 'fleet is a driver name teamai reserves, and no driver of it exists yet' });
  });

  it.each(['', '-acme', '.acme', 'acme sandbox', 'acme/sandbox', 'Local '])('refuses %j, which is not a driver name', (name) => {
    expect(parseDriver(name)).toEqual({ ok: false, reason: `${JSON.stringify(name)} is not a driver name: letters, digits, dot, underscore and hyphen, starting with a letter or digit` });
  });

  it('reads the reserved names exactly, so another case is a driver definition', () => {
    expect(parseDriver('Local')).toEqual({ ok: true, driver: { external: 'Local' } });
  });
});
