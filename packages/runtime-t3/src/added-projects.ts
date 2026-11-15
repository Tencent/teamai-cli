import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { readRegularFileSync } from '@teamai/shared/regular-file';

// ─── The T3 projects teamai added for folders of its own ───
//
//  A step's worktree that becomes a project of its own, a clone or a team repo's clone: teamai adds each such folder
//  to T3 Code as a project, and removes that project once teamai removed the folder, since the project's threads then
//  point at nothing. A folder can outlive the place that added its project (a clone later steps share), so the list
//  outlives places, in one file of its own beside the places' records:
//
//    ~/.teamai/runtime-state/t3/added-projects.json
//    [{ "id": "project-3f9c…", "folder": "/…/.teamai/workflow-worktrees/r928e…-a96c8bc03" }]
//
//  The main checkout of the folder a run started in is the member's project, and is never on it.
//

const AddedProjectSchema = z.object({ id: z.string().min(1), folder: z.string().min(1) });

export type AddedProject = z.infer<typeof AddedProjectSchema>;

export interface AddedProjects {
  /** The projects teamai added and has not removed yet; a file that cannot be read lists none, so none is removed. */
  list(): AddedProject[];
  add(project: AddedProject): void;
  /** Forgets the project, once T3 no longer has it. */
  drop(id: string): void;
}

export function addedProjects(file: string): AddedProjects {
  const list = (): AddedProject[] => {
    try {
      return z.array(AddedProjectSchema).parse(JSON.parse(readRegularFileSync(file, 'utf8')));
    } catch {
      return [];
    }
  };

  const save = (projects: AddedProject[]): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(projects), { mode: 0o600 });
    fs.renameSync(temp, file);
  };

  return {
    list,
    add: (project) => save([...list().filter((one) => one.id !== project.id), project]),
    drop: (id) => save(list().filter((one) => one.id !== id)),
  };
}
