/**
 * The team role a workflow copy runs with (a step's `role`), recorded for the copy in `checkout-roles.json` in the data
 * home that governs it, `{ [copy real path]: role }`, and applied to its config on every load (`withCheckoutRole`).
 * Every pull, hook and step tool in the copy then reads the same selection, so they deliver for that role through the
 * code they already run. Writers take the file's own lock; readers take none, as each write is atomic.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { getCheckoutRolesPath, type LocalConfig } from './types.js';
import { readJsonObject, writeJsonAtomic } from './utils/fs.js';
import { warnOnce } from './utils/warn-once.js';
import { withFileLock } from './update.js';

const CheckoutRolesSchema = z.record(z.string().min(1), z.string().min(1));

type CheckoutRoles = z.infer<typeof CheckoutRolesSchema>;

/** How long a writer waits for another writer of the file: they each hold it for one small read and write. */
const CHECKOUT_ROLES_LOCK_WAIT = { attempts: 50, delayMs: 100 };

/** What a write of the file did: done, the lock still busy after the wait, or a file it cannot read and so must not rewrite. */
export type CheckoutRoleWrite =
  | { kind: 'recorded' }
  | { kind: 'busy'; lock: string }
  | { kind: 'unreadable'; file: string; error: string };

type RolesRead = { kind: 'ok'; roles: CheckoutRoles } | { kind: 'unreadable'; error: string };

async function readCheckoutRoles(file: string): Promise<RolesRead> {
  const read = await readJsonObject(file);

  if (read.kind === 'missing') return { kind: 'ok', roles: {} };

  if (read.kind === 'invalid') return { kind: 'unreadable', error: read.error };
  const parsed = CheckoutRolesSchema.safeParse(read.value);

  return parsed.success ? { kind: 'ok', roles: parsed.data } : { kind: 'unreadable', error: 'a value is not a role id' };
}

/** The key of `checkout` in the file: its real path, as `resolveAnchors` gives a workspace root. */
async function checkoutKeyOf(checkout: string): Promise<string> {
  return fs.realpath(checkout).catch(() => path.resolve(checkout));
}

/** Records that `checkout`, a workflow copy that `config`'s data home governs, runs with team role `role`. */
export async function recordCheckoutRole(input: { config: LocalConfig; checkout: string; role: string }): Promise<CheckoutRoleWrite> {
  const key = await checkoutKeyOf(input.checkout);
  const file = getCheckoutRolesPath(input.config);
  const lock = `${file}.lock`;

  const written = await withFileLock(lock, CHECKOUT_ROLES_LOCK_WAIT, async (): Promise<CheckoutRoleWrite> => {
    const read = await readCheckoutRoles(file);

    if (read.kind === 'unreadable') return { kind: 'unreadable', file, error: read.error };
    await writeJsonAtomic(file, { ...read.roles, [key]: input.role });

    return { kind: 'recorded' };
  });

  return written.held ? written.value : { kind: 'busy', lock };
}

/**
 * `config` with `stepRole` set to the role recorded for the copy it governs, or without one when none is. A project
 * config only: a copy runs only under a project install. Applied after the member's role assignment, at every load.
 */
export async function withCheckoutRole(config: LocalConfig): Promise<LocalConfig> {
  const { stepRole: _previous, ...member } = config;

  if (config.scope !== 'project' || config.projectRoot === undefined) return member;
  const file = getCheckoutRolesPath(config);
  const read = await readCheckoutRoles(file);

  if (read.kind === 'unreadable') {
    warnOnce(`${file} cannot be read (${read.error}), so no workflow copy of this project runs with a team role until it is fixed or deleted.`);

    return member;
  }

  const role = read.roles[await checkoutKeyOf(config.projectRoot)];

  return role === undefined ? member : { ...member, stepRole: role };
}
