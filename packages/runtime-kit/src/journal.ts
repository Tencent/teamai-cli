import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { mayBeRunning } from '@teamai/shared/process-group';
import { readRegularFileSync } from '@teamai/shared/regular-file';

// ─── What a runtime keeps across its own processes ───────
//
//  One file per record, written whole through a rename, so a runtime killed mid-write leaves the previous record, and
//  two processes that write different records never lose each other's write. `update` holds its key while it reads and
//  writes, so two that write the same record never lose one either. A record that is there but cannot be read is told
//  apart from one that is not there: it may hold work that still runs. `hold` keeps one process at a time on a key,
//  across processes, for a write that reads what it replaces.
//

/** A record by its key: none, or one that is there and cannot be read, which is not the same. */
export type RecordRead<TRecord> = { kind: 'found'; record: TRecord } | { kind: 'missing' } | { kind: 'unreadable'; file: string; why: string };

export interface RecordStore<TRecord> {
  read(key: string): RecordRead<TRecord>;
  write(key: string, record: TRecord): void;
  /**
   * Writes `key`'s record as `change` makes it from the one there, holding the key across processes meanwhile, so a
   * write another process makes between the read and this one is never lost; `undefined` writes nothing. A record
   * there that cannot be read is never written over: that rejects, naming its file.
   */
  update(key: string, change: (record: TRecord | undefined) => TRecord | undefined): Promise<void>;
  remove(key: string): void;
  /** Every key the store holds a record for, readable or not. */
  keys(): string[];
  /** The file that holds `key`'s record, which a person may be told to delete. */
  file(key: string): string;
}

/** The records of `schema` in `dir`, one `<key>.json` each, readable by their owner only. */
export function recordStore<TSchema extends z.ZodType>(dir: string, schema: TSchema): RecordStore<z.infer<TSchema>> {
  const file = (key: string): string => path.join(dir, `${encodeURIComponent(key)}.json`);

  const read = (key: string): RecordRead<z.infer<TSchema>> => {
    const at = file(key);
    let text: string;

    try {
      text = readRegularFileSync(at, 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { kind: 'missing' };

      return { kind: 'unreadable', file: at, why: error instanceof Error ? error.message : String(error) };
    }

    try {
      const parsed = schema.safeParse(JSON.parse(text));

      return parsed.success ? { kind: 'found', record: parsed.data } : { kind: 'unreadable', file: at, why: z.prettifyError(parsed.error) };
    } catch (error) {
      return { kind: 'unreadable', file: at, why: error instanceof Error ? error.message : String(error) };
    }
  };

  const write = (key: string, record: z.infer<TSchema>): void => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = `${file(key)}.${process.pid}.${randomUUID()}.tmp`;

    try {
      fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
      fs.renameSync(temp, file(key));
    } finally {
      fs.rmSync(temp, { force: true });
    }
  };

  return {
    read,
    write,
    async update(key, change) {
      const release = await hold(dir, key);

      try {
        const found = read(key);

        if (found.kind === 'unreadable') throw new Error(`${found.file} cannot be read (${found.why.replace(/\.$/, '')}), so it is not written over.`);
        const next = change(found.kind === 'found' ? found.record : undefined);

        if (next !== undefined) write(key, next);
      } finally {
        release();
      }
    },
    remove: (key) => fs.rmSync(file(key), { force: true }),
    keys: () => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => decodeURIComponent(name.slice(0, -'.json'.length))).sort() : []),
    file,
  };
}

/** The pid a hold file starts with. */
const HoldPidSchema = z.coerce.number().int().positive();

/**
 * How old a hold may grow before another process takes it over: one older than this is stuck, or gone with its pid in
 * use since.
 */
export const HOLD_STALE_MS = 60_000;

/** The hold at `file`: its text, the pid that holds it when it names one, and when it was taken; none once released. */
function holdAt(file: string): { text: string; pid: number | undefined; takenAt: number } | undefined {
  let text: string;
  let takenAt: number;

  try {
    text = readRegularFileSync(file, 'utf8');
    takenAt = fs.statSync(file).mtimeMs;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }

  const pid = HoldPidSchema.safeParse(text.split(' ')[0]);

  return { text, pid: pid.success ? pid.data : undefined, takenAt };
}

/**
 * Removes the hold at `file` when it is still the one whose text is `text`: one another process took over since is put
 * back. It is moved aside first, so no hold is removed between the read and the removal.
 */
function releaseHold({ file, text }: { file: string; text: string }): void {
  const aside = path.join(path.dirname(file), `.${process.pid}.${randomUUID()}.aside`);

  try {
    fs.renameSync(file, aside);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }

  try {
    if (readRegularFileSync(aside, 'utf8') !== text) fs.linkSync(aside, file);
  } finally {
    fs.rmSync(aside, { force: true });
  }
}

/** Holds `file` for one process at a time, waiting while a live one holds it, and taking it from one gone or stuck. */
async function holdFile(dir: string, file: string): Promise<() => void> {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Written whole, then linked into place, so another process never reads a hold with no pid in it. Each hold is told
  // apart from every other, so a hold found stale is never mistaken for one another process took since.
  const mine = path.join(dir, `.${process.pid}.${randomUUID()}.tmp`);
  const text = `${process.pid} ${randomUUID()}`;

  try {
    for (;;) {
      try {
        // Written again before each try, so a hold's age counts from when it was taken, not from when it began to wait.
        fs.writeFileSync(mine, text, { mode: 0o600 });
        fs.linkSync(mine, file);

        return () => releaseHold({ file, text });
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      }

      const held = holdAt(file);

      // Released since the link failed: try again.
      if (held === undefined) continue;

      if (held.pid !== undefined && held.pid !== process.pid && mayBeRunning(held.pid) && Date.now() - held.takenAt < HOLD_STALE_MS) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }

      // Its process is gone, or held it too long. A hold another process took in its place since it was read is put
      // back, so two processes that both found it stale never both hold.
      releaseHold({ file, text: held.text });
    }
  } finally {
    fs.rmSync(mine, { force: true });
  }
}

/** The last hold this process took or waits for, by hold file: a file names one process, so this one queues its own. */
const queued = new Map<string, Promise<void>>();

/**
 * Holds `key` in `dir` for one caller at a time, across processes and within this one, waiting while another holds
 * it, and taking it from a process that died or has held it for `HOLD_STALE_MS`. Resolves to its release; rejects when
 * the hold cannot be written.
 */
export async function hold(dir: string, key: string): Promise<() => void> {
  const file = path.join(dir, createHash('sha256').update(key).digest('hex').slice(0, 32));
  let leave = (): void => {};
  const left = new Promise<void>((resolve) => { leave = resolve; });
  const turn = queued.get(file) ?? Promise.resolve();
  const mine = turn.then(() => left);
  queued.set(file, mine);

  const done = (): void => {
    leave();

    if (queued.get(file) === mine) queued.delete(file);
  };

  // A caller that never releases is waited for no longer than one that died would be: its hold is then taken over.
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([turn, new Promise<void>((resolve) => { timer = setTimeout(resolve, HOLD_STALE_MS); })]);
  clearTimeout(timer);

  try {
    const release = await holdFile(dir, file);

    return () => {
      release();
      done();
    };
  } catch (error) {
    done();
    throw error;
  }
}
