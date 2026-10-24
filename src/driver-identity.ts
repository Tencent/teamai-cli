import { z } from 'zod';

/** The driver that takes workflow steps and judge leases, as stored with each lease: per-request capabilities omitted. */
export const DriverSchema = z.object({ kind: z.string(), machine: z.string(), workspace: z.string() });
