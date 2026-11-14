/**
 * The driver names teamai keeps for its own drivers, the one place they are written: `local`, `skill` and `none`, which
 * `parseDriver` gives, `fleet`, which it refuses until such a driver exists, and `host`, the definition teamai builds
 * in. No driver definition file takes one. This module imports nothing, so every reader may import it: the skill
 * driver's transitions, which import types alone, read `HostDriverName`.
 */
export const RESERVED_DRIVERS = { local: 'local', skill: 'skill', none: 'none', fleet: 'fleet', host: 'host' } as const;

export type ReservedDriverName = (typeof RESERVED_DRIVERS)[keyof typeof RESERVED_DRIVERS];

/** The built-in definition with no runtime, which runs only the host slot. */
export type HostDriverName = typeof RESERVED_DRIVERS.host;

const RESERVED: ReadonlySet<string> = new Set(Object.values(RESERVED_DRIVERS));

/** Whether `name` is one teamai keeps for its own drivers, exactly as written. */
export function isReservedDriver(name: string): name is ReservedDriverName {
  return RESERVED.has(name);
}
