## Summary

Fixes Part 2 of #1503: Codex team-hook stdout/stderr is now accumulated as raw buffers and decoded once after the child exits, so UTF-8 characters split across pipe chunks are preserved.

Adds a built-CLI regression that runs a Codex team hook whose stdout splits the UTF-8 bytes of `猫` across two writes; the dispatcher returns valid JSON with the intact character. The regression fails with the earlier per-chunk decoder and passes with this change.

## Validation

- `npm run build`
- `npm run typecheck`
- `npm run lint`
- `npx vitest run src/__tests__/codex-team-hooks.test.ts --pool=forks` — 8 passed
- built CLI: `node dist/index.js hook-dispatch Stop --tool codex --team-hooks`, via the dispatcher fixture with an isolated `HOME` and a hook that writes `猫` across two stdout writes — exit 0; output byte-for-byte parses as `{ "systemMessage": "猫" }`
- `npx vitest run --config vitest.e2e.config.ts src/__tests__/e2e/codex-team-hook-dispatcher-915.test.ts --testNamePattern "split across hook writes" --pool=forks` — 1 passed
- `git diff --check`

On Windows the focused E2E uses `TMP=C:\\tmp` to keep the fixture's Git paths below the legacy path-length limit.

## Disclosure

Slai Agent Runtime assisted with investigation, implementation, and test execution. The account owner reviewed and authorized this contribution and is responsible for its content.

## Related issue

Part 2 of #1503.