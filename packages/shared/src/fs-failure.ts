import fs from 'node:fs';
import { z } from 'zod';

/**
 * What Node's file system says of a file or folder it could not read: its code, the path it names, and its message. An
 * error with no code is not the file system's, and does not parse.
 */
export const FsFailureSchema = z.object({
  code: z.string().min(1),
  path: z.string().optional(),
  message: z.string(),
});

export type FsFailure = z.infer<typeof FsFailureSchema>;

/** Whether `failure` says there is nothing there to read. */
export function isMissing({ code }: FsFailure): boolean {
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Whether `failure` says the user teamai runs as has no permission to read what it names. */
export function isPermissionDenied({ code }: FsFailure): boolean {
  return code === 'EACCES' || code === 'EPERM';
}

/** Why teamai cannot read what `failure` names, to follow "because". */
export function cannotReadBecause(failure: FsFailure): string {
  return isPermissionDenied(failure) ? 'it has no permission to read it' : `reading it failed (${failure.message})`;
}

/**
 * Whether the user teamai runs as can list `folder`, or it does not exist yet, as a tool's store before its first session.
 * One that exists in a folder this user cannot enter fails as no permission, never as missing.
 */
export function canList(folder: string): boolean {
  try {
    fs.accessSync(folder, fs.constants.R_OK | fs.constants.X_OK);

    return true;
  } catch (error) {
    const failure = FsFailureSchema.safeParse(error);

    if (!failure.success) throw error;

    return isMissing(failure.data);
  }
}
