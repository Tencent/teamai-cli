import fse from 'fs-extra';
import { readFileSafe, remove, writeFile } from './fs.js';

/**
 * Inject or replace a marker-delimited section in a CLAUDE.md file.
 *
 * Behavior:
 *   - Both markers present → replace content between them (inclusive).
 *   - Neither marker present → append the block to the end of the file.
 *   - Only one marker present (corrupted) → append the block (safe fallback).
 *   - File does not exist → create it with just the block, which is how
 *     `removeClaudeMdSection` tells a file teamai created from a member's.
 *
 * @param filePath  Absolute path to the CLAUDE.md file.
 * @param startMarker  Opening marker comment, e.g. `<!-- [teamai:culture:start] -->`.
 * @param endMarker  Closing marker comment.
 * @param block  The full replacement block **including** both markers.
 */
export async function injectClaudeMdSection(
    filePath: string,
    startMarker: string,
    endMarker: string,
    block: string,
): Promise<void> {
    const existing = await readFileSafe(filePath);

    if (existing === null) {
        await writeFile(filePath, block + '\n');

        return;
    }

    const startIdx = existing.indexOf(startMarker);
    const endIdx = existing.indexOf(endMarker);

    let updated: string;

    if (startIdx !== -1 && endIdx !== -1) {
        // Both markers found → replace
        updated = existing.substring(0, startIdx) + block + existing.substring(endIdx + endMarker.length);
    } else {
        // Neither or only one marker → append
        updated = existing.trimEnd() + '\n\n' + block + '\n';
    }

    await writeFile(filePath, updated);
}

/**
 * Remove a marker-delimited managed section while preserving user content.
 * Returns whether a section was removed. With `deleteIfEmpty`, a file left
 * holding only whitespace is deleted when it opens with the section, as the
 * file `injectClaudeMdSection` created does; a member's file that was empty
 * before the section was appended is left empty instead. A file without the
 * section is never touched.
 */
export async function removeClaudeMdSection(
    filePath: string,
    startMarker: string,
    endMarker: string,
    options: { deleteIfEmpty?: boolean } = {},
): Promise<boolean> {
    const existing = await readFileSafe(filePath);

    if (!existing) return false;

    const startIdx = existing.indexOf(startMarker);
    const endIdx = existing.indexOf(endMarker);

    if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return false;

    const before = existing.substring(0, startIdx).replace(/\n+$/, '\n');
    // A file that opened with this section opens with whatever follows it, so
    // a teamai-created file still reads as teamai's when its next section goes.
    const after = existing.substring(endIdx + endMarker.length).replace(/^\n+/, startIdx === 0 ? '' : '\n');
    const rest = (before + after).trimEnd();

    if (options.deleteIfEmpty && rest.trim() === '') {
        // A link is the member's (a dotfiles setup): it stays, and its target is emptied instead.
        const isLink = (await fse.lstat(filePath).catch(() => null))?.isSymbolicLink() ?? false;

        if (startIdx === 0 && !isLink) await remove(filePath);
        else await writeFile(filePath, '');
    } else {
        await writeFile(filePath, rest + '\n');
    }

    return true;
}
