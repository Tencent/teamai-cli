/**
 * The name of a workflow driver, as `--driver` and `workflows.driver` give it. teamai reserves `local`, `none`, `skill`
 * and `fleet`, exactly as written. Any other name in the format is a driver definition a member, the team or teamai
 * provides.
 */
import { z } from 'zod';

const DRIVER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export const DriverNameSchema = z.string().regex(DRIVER_NAME).brand<'DriverName'>();

export type DriverName = z.infer<typeof DriverNameSchema>;

/** The local driver's name: the driver a start drives when neither `--driver` nor `workflows.driver` names one. */
export const LOCAL_DRIVER = DriverNameSchema.parse('local');

/** The driver a name stands for: one of teamai's own, or a driver definition outside it. */
export type Driver = 'local' | 'skill' | 'none' | { external: DriverName };

/** The driver `name` stands for, or why it stands for none. */
// oxlint-disable-next-line teamai/no-unknown-parameters -- the parse itself: `workflows.driver` is kept as written at each level
export function parseDriver(name: unknown): { ok: true; driver: Driver } | { ok: false; reason: string } {
  const parsed = DriverNameSchema.safeParse(name);

  if (!parsed.success) return { ok: false, reason: `${JSON.stringify(name)} is not a driver name: letters, digits, dot, underscore and hyphen, starting with a letter or digit` };

  switch (parsed.data) {
    case 'local':
      return { ok: true, driver: 'local' };
    case 'skill':
      return { ok: true, driver: 'skill' };
    case 'none':
      return { ok: true, driver: 'none' };
    case 'fleet':
      return { ok: false, reason: 'fleet is a driver name teamai reserves, and no driver of it exists yet' };
    default:
      return { ok: true, driver: { external: parsed.data } };
  }
}
