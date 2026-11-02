// Adapted from require-suppression-reason in pingdotgg/t3code (MIT, Copyright (c) 2026 T3 Tools Inc.).
import { defineRule } from '@oxlint/plugins';

/** A lint or TypeScript suppression comment. */
const DIRECTIVE = /^\s*[*/]?\s*(?:(?:oxlint|eslint)-(?:disable|enable)|@ts-(?:expect-error|ignore|nocheck))/u;

/** A TypeScript suppression, capturing the text after it. */
const TS_DIRECTIVE = /^\s*[*/]?\s*@ts-(?:expect-error|ignore|nocheck)(?![\w-])(.*)$/su;
const EMPTY_COMMENT = /^[\s*]*$/u;

export default defineRule({
  meta: {
    type: 'suggestion',
    docs: { description: 'Require every lint or type-checker suppression to say why.' },
  },
  create(context) {
    const { sourceCode } = context;

    return {
      Program() {
        const comments = sourceCode.getAllComments();
        /** @type {Map<number, import('@oxlint/plugins').Comment>} */
        const ownLineCommentsByEndLine = new Map();

        for (const comment of comments) {
          const { line, column } = comment.loc.start;

          if ((sourceCode.lines[line - 1] ?? '').slice(0, column).trim() === '') ownLineCommentsByEndLine.set(comment.loc.end.line, comment);
        }

        /**
         * A directive is explained by the nearest own-line comment above it
         * that is neither another directive nor empty.
         * @param {import('@oxlint/plugins').Comment} directive
         */
        const explainedAbove = (directive) => {
          let above = ownLineCommentsByEndLine.get(directive.loc.start.line - 1);

          while (above && (DIRECTIVE.test(above.value) || EMPTY_COMMENT.test(above.value))) {
            above = ownLineCommentsByEndLine.get(above.loc.start.line - 1);
          }

          return above !== undefined;
        };

        for (const directive of sourceCode.getDisableDirectives().directives) {
          if (directive.type === 'enable' || directive.justification.trim() || explainedAbove(directive.node)) continue;
          context.report({
            loc: directive.node.loc,
            message: 'Say why: end the directive with `-- reason` or put a comment on the line above.',
          });
        }

        for (const comment of comments) {
          const after = TS_DIRECTIVE.exec(comment.value)?.[1];

          if (after === undefined || after.replace(/^[\s:-]+/u, '').trim() || explainedAbove(comment)) continue;
          context.report({
            loc: comment.loc,
            message: 'Say why: write the reason after the directive or in a comment on the line above.',
          });
        }
      },
    };
  },
});
