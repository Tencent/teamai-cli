<!--
Thanks for opening a PR! Please fill out this template to help reviewers understand your change quickly.
-->

## Summary

<!-- 1-3 sentences: what does this PR do and why? -->

## Type of Change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature causing existing behavior to change)
- [ ] Documentation only
- [ ] Refactor / internal cleanup

## Test Plan

<!-- The focused tests or manual checks you ran and what you observed. State anything
you could not check. "Tests pass" alone is not enough; CI runs the full suite.

For UI changes, include clear before/after screenshots. Include a short recording
when motion, timing, transitions, or interaction details are needed to demonstrate
the change. Upload evidence to GitHub and embed or link it here. Never commit PR-only assets. -->

- [ ] `npx tsc --noEmit` passes
- [ ] `npm run lint` passes
- [ ] The test files that cover what I changed pass (`npx vitest run <test files>`); the full `npx vitest run` passes if the change touches `src/__tests__/helpers/`, a `vitest*.config.ts`, `package.json` or `package-lock.json`. CI runs the full suite on every push to a PR.
- [ ] Added/updated tests for the change
- [ ] Runtime change: one real-CLI run in a world (`npm run verify:world`; `npm run -s verify -- help` says how, and `help drivers` for where a step runs), pasted below with its verdict, combination and entry point, commands, build line and the ledger's last line. Not needed for a docs-only, tests-only or lint-rule-only change.

<!-- Real-CLI record, for example:
VERIFIED: claude x git x project scope via teamai pull
$ npm run -s verify -- teamai <run> pull
Build <commit>, teamai <version>, sha256 <prefix>
Ledger: CLEAN -->

## Related Issues

<!-- Closes #123, Fixes #456 -->

## Notes for Reviewers

<!-- Anything reviewers should pay particular attention to (tricky logic, trade-offs, follow-ups) -->
