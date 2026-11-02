// Adapted from no-low-value-comments in pingdotgg/t3code (MIT, Copyright (c) 2026 T3 Tools Inc.), without the checks
// this repository's conventions contradict: issue numbers in comments, `// ───` section dividers, and a length cap.
/** @import { ESTree } from '@oxlint/plugins' */
import { defineRule } from '@oxlint/plugins';

const TS_FILE = /\.[cm]?tsx?$/u;
const DIRECTIVE = /^\s*(?:(?:oxlint|eslint)-|@ts-|prettier-ignore|c8 |istanbul |#(?:end)?region)/u;
const TEST_STEP = /^(?:arrange|act|assert|given|when|then)\s*[:.]?$/iu;
const TASK_MARKER = /\b(?:TODO|FIXME|XXX|HACK)\b/u;
const TASK_LINK = /#\d+|https?:\/\//u;
const JSDOC_TYPE = /^@(?:param|returns?|type|typedef)\s+\{/u;
const EMPTY_JSDOC_TAG = /^@(?:param(?:\s+\[?[\w$.]+\]?)?|returns?)$/u;
const COMMENTED_CODE = /^(?:(?:(?:const|let|var)\s+[\w${}[\], ]+=.*|import\s.+\sfrom\s+["'].+["']|(?:await\s+|return\s+)?[\w$.]+\(.*\)|[\w$.[\]]+\s*=\s*.+);|(?:if|for|while|switch)\s*\(.*\)\s*\{|\}(?:\s*else\s*\{)?)$/u;
const DECLARATION = /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:static\s+)?(?:readonly\s+)?(?:(?:const|let|var|function\*?|class|interface|type|enum)\s+)?([A-Za-z_$][\w$]*)\s*[?!]?\s*[:=(<{]/u;

/** Text in a script with no word separators, such as Chinese: a comment holding it says more than the name. */
const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const FILLER_WORDS = new Set('a an the of for to in on at by with from and or is are be this that it its as get set return create new current value given whether'.split(' '));

/** @param {string} word */
const stem = (word) => (word.length > 3 ? word.replace(/([^s])s$/u, '$1') : word);

/** @param {string} text */
const words = (text) => (text.toLowerCase().match(/[a-z0-9]+/gu) ?? []).filter((word) => !FILLER_WORDS.has(word)).map(stem).filter((word) => !FILLER_WORDS.has(word));

/** @param {string} name */
const identifierWords = (name) => words(name.replace(/([a-z0-9])([A-Z])/gu, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/gu, '$1 $2'));

/** @param {ESTree.Comment} comment */
const commentLines = (comment) => comment.value.split('\n').map((line) => line.replace(/^\s*\*?\s?/u, '').trim()).filter((line) => line !== '');

export default defineRule({
  meta: {
    type: 'suggestion',
    docs: { description: 'Reject comments that only repeat the code, keep commented-out code, or narrate tests.' },
  },
  create(context) {
    const { sourceCode } = context;
    const isTypeScript = TS_FILE.test(context.filename);

    /**
     * Whether the comment ending on `lastLine` says no more than the name declared on the line after it.
     * @param {number} lastLine
     * @param {readonly string[]} lines
     */
    const restatesNextName = (lastLine, lines) => {
      if (lines.some((line) => line.startsWith('@') || UNSPACED_SCRIPT.test(line))) return false;
      const name = DECLARATION.exec(sourceCode.lines[lastLine] ?? '')?.[1];

      if (name === undefined) return false;
      const content = words(lines.join(' '));

      if (content.length === 0 || content.length > 6) return false;
      const nameWords = new Set(identifierWords(name));

      return content.every((word) => nameWords.has(word));
    };

    /**
     * What is wrong with one comment, or undefined.
     * @param {readonly ESTree.Comment[]} comments
     * @param {readonly string[]} lines
     */
    const problem = (comments, lines) => {
      const text = comments.map((comment) => comment.value).join('\n');
      const first = comments[0];
      const last = comments.at(-1);

      if (!first || !last || lines.length === 0 || comments.some((comment) => DIRECTIVE.test(comment.value))) return undefined;
      const isLine = first.type === 'Line';

      if (isLine && lines.length === 1 && TEST_STEP.test(lines[0] ?? '')) return 'Drop the test step label.';

      if (TASK_MARKER.test(text) && !TASK_LINK.test(text)) return 'Link the issue that tracks this, or drop the marker.';

      if (isTypeScript && lines.some((line) => JSDOC_TYPE.test(line))) return 'Drop the JSDoc type; TypeScript already has it.';

      if (lines.some((line) => EMPTY_JSDOC_TAG.test(line))) return 'Drop the JSDoc tag that has no description.';

      if (isLine && lines.every((line) => COMMENTED_CODE.test(line))) return 'Delete commented-out code; git keeps the history.';

      if (restatesNextName(last.loc.end.line, lines)) return 'Drop the comment; it only repeats the name below it. Say why, or say nothing.';

      return undefined;
    };

    return {
      Program() {
        // Consecutive `//` lines at one indent read as one comment.
        /** @type {Array<{ comments: ESTree.Comment[]; lines: string[] }>} */
        const groups = [];

        for (const comment of sourceCode.getAllComments()) {
          const group = groups.at(-1);
          const previous = group?.comments.at(-1);

          const continues = comment.type === 'Line' && previous?.type === 'Line'
            && previous.loc.end.line === comment.loc.start.line - 1 && previous.loc.start.column === comment.loc.start.column;

          if (group && continues) {
            group.comments.push(comment);
            group.lines.push(...commentLines(comment));
          } else {
            groups.push({ comments: [comment], lines: commentLines(comment) });
          }
        }

        for (const { comments, lines } of groups) {
          const message = problem(comments, lines);
          const first = comments[0];
          const last = comments.at(-1);

          if (message !== undefined && first && last) context.report({ loc: { start: first.loc.start, end: last.loc.end }, message });
        }
      },
    };
  },
});
