import { readFileSafe, writeFile } from './fs.js';

/**
 * Inject or replace a marker-delimited section in a CLAUDE.md file.
 *
 * Behavior:
 *   - Both markers present → replace content between them (inclusive).
 *   - Neither marker present → append the block to the end of the file.
 *   - Only one marker present (corrupted) → append the block (safe fallback).
 *   - File does not exist → create it with just the block.
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
    const existing = await readFileSafe(filePath) ?? '';

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
