import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { LocalConfig } from '../types.js';
import { WorkflowFolder } from '../workflow/folder.js';

/** Runs `during` once, when the prune looks at `at`, between its look and its removal. */
const between = vi.hoisted(() => ({ at: '', during: undefined as (() => Promise<void>) | undefined }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const stat = async (...args: Parameters<typeof actual.stat>) => {
    const stats = await actual.stat(...args);
    const { during } = between;

    if (String(args[0]) === between.at && during !== undefined) {
      between.during = undefined;
      await during();
    }

    return stats;
  };

  return { ...actual, stat, default: { ...actual, stat } };
});

const roots: string[] = [];

afterEach(() => {
  between.during = undefined;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it('keeps a stored folder that a start pins while doctor --fix is about to remove it as an hour unreferenced', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-folder-pin-prune-'));
  roots.push(root);
  const config: LocalConfig = { repo: { localPath: path.join(root, 'team-repo'), remote: 'local', kind: 'self' }, username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data') };
  const files = [{ path: 'plan.txt', executable: false, content: 'the run reads this' }];
  const sourceHash = WorkflowFolder.hash(files);
  await WorkflowFolder.pin(config, { sourceHash, files });
  const stored = WorkflowFolder.dir(config, sourceHash) ?? '';
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(stored, twoHoursAgo, twoHoursAgo);
  let pinned: Promise<void> | undefined;
  between.at = stored;
  // A start pins the folder after the prune found it old: the pin returns at once, or waits on the prune when they share a lock.
  between.during = async () => {
    pinned = WorkflowFolder.pin(config, { sourceHash, files });
    await Promise.race([pinned, new Promise((resolve) => { setTimeout(resolve, 300); })]);
  };

  await WorkflowFolder.prune(config, { referenced: new Set(), now: Date.now() });
  await pinned;

  expect(pinned).toBeDefined();
  expect(fs.readFileSync(path.join(stored, 'plan.txt'), 'utf8')).toBe('the run reads this');
});

it('keeps an hour-old stored folder that a fleet claim pins after doctor --fix read the folders held, since the pin is newer than the sweep', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-folder-pin-prune-'));
  roots.push(root);
  const config: LocalConfig = { repo: { localPath: path.join(root, 'team-repo'), remote: 'local', kind: 'self' }, username: 'tester', scope: 'project', additionalRoles: [], projectRoot: root, dataHome: path.join(root, 'data') };
  const files = [{ path: 'plan.txt', executable: false, content: 'the claimed step reads this' }];
  const sourceHash = WorkflowFolder.hash(files);
  await WorkflowFolder.pin(config, { sourceHash, files });
  const stored = WorkflowFolder.dir(config, sourceHash) ?? '';
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(stored, twoHoursAgo, twoHoursAgo);
  // The sweep takes its time, then reads the held folders: the claim has not noted this one yet, so none is referenced.
  const sweptAt = Date.now();
  const referenced = new Set<string>();
  // The claim notes its folders, then pins them, before the sweep's prune looks.
  await new Promise((resolve) => { setTimeout(resolve, 5); });
  await WorkflowFolder.pin(config, { sourceHash, files });

  await WorkflowFolder.prune(config, { referenced, now: sweptAt });

  expect(fs.readFileSync(path.join(stored, 'plan.txt'), 'utf8')).toBe('the claimed step reads this');
  // The same folder, unpinned since the sweep began, goes.
  fs.utimesSync(stored, twoHoursAgo, twoHoursAgo);
  await WorkflowFolder.prune(config, { referenced, now: sweptAt });
  expect(fs.existsSync(stored)).toBe(false);
});
