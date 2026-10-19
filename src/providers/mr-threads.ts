import type { MRThread } from '../types.js';

/**
 * Every comment `teamai ci extract-mr` posts carries an HTML marker with this
 * prefix (`<!-- teamai:ci-extract -->`, `<!-- teamai:ci-extract:<id> -->`, the
 * codebase-graph marker). A fetch of the review threads leaves them out so the
 * CI extraction does not feed its own output back in (#1187).
 */
const TEAMAI_COMMENT_PREFIX = '<!-- teamai:';

/**
 * True for a comment teamai itself posted on the MR: one carrying the default
 * prefix, or the marker `teamai ci extract-mr --comment-marker` posted with.
 */
export function isTeamaiComment(body: string, commentMarker?: string): boolean {
  return body.includes(TEAMAI_COMMENT_PREFIX) || (!!commentMarker && body.includes(commentMarker));
}

/**
 * Drops teamai's own comments and blank notes from every thread, and the
 * threads that are left with no note.
 *
 * @param commentMarker  A custom `--comment-marker` to drop besides the default prefix
 */
export function pruneThreads(threads: MRThread[], commentMarker?: string): MRThread[] {
  return threads
    .map((thread) => ({
      ...thread,
      notes: thread.notes.filter((note) => note.body.trim() !== '' && !isTeamaiComment(note.body, commentMarker)),
    }))
    .filter((thread) => thread.notes.length > 0);
}
