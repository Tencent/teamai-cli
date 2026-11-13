/**
 * A team folder named like a teamai default folder holds only the files it changes; every other file, the marker
 * included, comes from teamai's folder. Only a teamai default is inherited from: a team folder never inherits from
 * another team folder, and a file of the same name replaces a folder whole.
 */
import path from 'node:path';
import { isLanguageVariant } from './resolver.js';

/** Which layer a file of a resulting folder comes from. */
export type FolderFileLayer = 'team' | 'teamai';

/** The files a team folder and the teamai default under it make, each with its layer, and the team files that replace nothing. */
export interface InheritedFolder<TFile extends { readonly path: string }> {
  readonly files: ReadonlyArray<TFile & { readonly layer: FolderFileLayer }>;
  /** Team files whose language family teamai's folder does not have, while the team keeps teamai's marker: not in `files`. */
  readonly strays: readonly string[];
}

/** What a team folder took from the teamai default of its name: the teamai version that shipped it, and the paths of the files it gave. */
export interface Inheritance {
  readonly teamaiVersion: string;
  readonly files: readonly string[];
}

/** The base text a file is a language variant of (`problem.zh.md` is `problem.md`'s), or the file itself. */
function familyOf(file: string): string {
  const dir = path.posix.dirname(file);
  const name = path.posix.basename(file);
  const ext = path.posix.extname(name);
  const lang = path.posix.extname(name.slice(0, name.length - ext.length));
  const base = `${name.slice(0, name.length - ext.length - lang.length)}${ext}`;
  const family = lang !== '' && isLanguageVariant(base, name) ? base : name;

  return dir === '.' ? family : `${dir}/${family}`;
}

/**
 * `team` over `teamai`, file by file. A team file replaces teamai's files of its language family (`problem.md`,
 * `problem.zh.md`, `problem.en.md`), so a language teamai has and the team does not never shows teamai's text. A team
 * file whose family teamai's folder lacks is a stray, left out, unless the team replaces `marker`, which may name it.
 */
function merge<TFile extends { readonly path: string }>(input: { readonly team: readonly TFile[]; readonly teamai: readonly TFile[]; readonly marker: string }): InheritedFolder<TFile> {
  const teamaiFamilies = new Set(input.teamai.map((file) => familyOf(file.path)));
  const ownsMarker = input.team.some((file) => familyOf(file.path) === input.marker);
  const strays = ownsMarker ? [] : input.team.filter((file) => !teamaiFamilies.has(familyOf(file.path))).map((file) => file.path);
  const own = input.team.filter((file) => !strays.includes(file.path));
  const replaced = new Set(own.map((file) => familyOf(file.path)));

  const files = [
    ...own.map((file) => ({ ...file, layer: 'team' as const })),
    ...input.teamai.filter((file) => !replaced.has(familyOf(file.path))).map((file) => ({ ...file, layer: 'teamai' as const })),
  ].sort((a, b) => (a.path < b.path ? -1 : 1));

  return { files, strays };
}

/** What `merged` took from teamai's version `teamaiVersion`, or null when every file is the team's. */
function inheritanceOf(merged: InheritedFolder<{ readonly path: string }>, teamaiVersion: string): Inheritance | null {
  const files = merged.files.flatMap((file) => (file.layer === 'teamai' ? [file.path] : []));

  return files.length === 0 ? null : { teamaiVersion, files };
}

/** How `list` and the dashboard name a folder of `total` files that took `inheritance`. */
function describe(inheritance: Inheritance, total: number): string {
  return `team, over teamai default ${inheritance.teamaiVersion} (${total - inheritance.files.length} own files, ${inheritance.files.length} inherited)`;
}

/** What pull prints about a stray of the team folder at `folderPath`. */
function strayMessage(folderPath: string, file: string): string {
  return `${folderPath}${file} replaces no file of teamai's default, so it is not used and teamai's files stay in force. `
    + 'Name it after the file it replaces, or replace the folder\'s marker too, so it can name the file.';
}

export const InheritedFolders = { merge, inheritanceOf, describe, strayMessage } as const;
