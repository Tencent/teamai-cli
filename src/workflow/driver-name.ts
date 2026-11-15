/**
 * The name of a workflow driver, as `--driver` and `workflows.driver` give it. teamai keeps the names in
 * `RESERVED_DRIVERS` for its own drivers. Any other name in the format is a driver definition a member, the team or
 * teamai provides; `host` parses as one too, the definition teamai builds in, which no file defines.
 */
import { z } from 'zod';
import { RESERVED_DRIVERS } from './reserved-drivers.js';

const DRIVER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export const DriverNameSchema = z.string().regex(DRIVER_NAME).brand<'DriverName'>();

export type DriverName = z.infer<typeof DriverNameSchema>;

/** The local driver's name: the driver a start drives when neither `--driver` nor `workflows.driver` names one. */
export const LOCAL_DRIVER = DriverNameSchema.parse(RESERVED_DRIVERS.local);

/** The definition the local driver runs: the member's, then the team's, then teamai's `drivers/teamai-local.yaml`. */
export const LOCAL_DEFINITION = DriverNameSchema.parse('teamai-local');

/**
 * The definition teamai builds in, with no runtime: only the host slot runs, so a run on it runs commands, gates and
 * workflows whose steps need no AI tool. No member's or team's file defines it, so no team repoints it.
 */
export const HOST_DRIVER = DriverNameSchema.parse(RESERVED_DRIVERS.host);

/** The driver a name stands for: one of teamai's own, or a driver definition outside it. */
export type Driver = typeof RESERVED_DRIVERS.local | typeof RESERVED_DRIVERS.skill | typeof RESERVED_DRIVERS.none | { external: DriverName };

/** The driver `name` stands for, or why it stands for none. */
// oxlint-disable-next-line teamai/no-unknown-parameters -- the parse itself: `workflows.driver` is kept as written at each level
export function parseDriver(name: unknown): { ok: true; driver: Driver } | { ok: false; reason: string } {
  const parsed = DriverNameSchema.safeParse(name);

  if (!parsed.success) return { ok: false, reason: `${JSON.stringify(name)} is not a driver name: letters, digits, dot, underscore and hyphen, starting with a letter or digit` };

  switch (parsed.data) {
    case RESERVED_DRIVERS.local:
      return { ok: true, driver: RESERVED_DRIVERS.local };
    case RESERVED_DRIVERS.skill:
      return { ok: true, driver: RESERVED_DRIVERS.skill };
    case RESERVED_DRIVERS.none:
      return { ok: true, driver: RESERVED_DRIVERS.none };
    case RESERVED_DRIVERS.fleet:
      return { ok: false, reason: 'fleet is a driver name teamai reserves, and no driver of it exists yet' };
    default:
      // `host` too: `--driver host` resolves as a definition, the one teamai builds in.
      return { ok: true, driver: { external: parsed.data } };
  }
}
