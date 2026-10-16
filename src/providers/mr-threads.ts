import type { MRThread } from '../types.js';

/**
 * Every comment `teamai ci extract-mr` posts carries an HTML marker with this
 * prefix (`<!-- teamai:ci-extract -->`, `<!-- teamai:ci-extract:<id> -->`, the
 * codebase-graph marker). A fetch of the review threads leaves them out so the
 * CI extraction does not feed its own output back in (#1187).
 */
const TEAMAI_COMMENT_PREFIX = '<!-- teamai:';

/** True for a comment teamai itself posted on the MR. */
export function isTeamaiComment(body: string): boolean {
  return body.includes(TEAMAI_COMMENT_PREFIX);
}

/**
 * Drops teamai's own comments and blank notes from every thread, and the
 * threads that are left with no note.
 */
export function pruneThreads(threads: MRThread[]): MRThread[] {
  return threads
    .map((thread) => ({
      ...thread,
      notes: thread.notes.filter((note) => note.body.trim() !== '' && !isTeamaiComment(note.body)),
    }))
    .filter((thread) => thread.notes.length > 0);
}
