import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

/** The driver that takes workflow steps and judge leases, as stored with each lease: per-request capabilities omitted. */
export const DriverSchema = z.object({ kind: z.string(), machine: z.string(), workspace: z.string() });

/** The identity a driver of `kind` sends from `workspace` on this machine, the same across its restarts there. */
export function driverIdentity(kind: string, workspace: string): z.infer<typeof DriverSchema> {
  let machine = 'unknown';
  try {
    machine = os.hostname();
  } catch {
    machine = 'unknown';
  }
  return { kind, machine, workspace: path.resolve(workspace) };
}

/** Whether `left` and `right` name the same driver: one kind, on one machine, in one workspace. */
export function sameDriver(left: z.infer<typeof DriverSchema>, right: z.infer<typeof DriverSchema>): boolean {
  return left.kind === right.kind && left.machine === right.machine && left.workspace === right.workspace;
}
