# anti-slop rules

Source: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) at `13909c9e07590f5a85d93c62712259fe14a883f7` (2026-10-13), MIT (`LICENSE`). This is also the base for the next update.

| Here | Upstream | State |
|---|---|---|
| `rules/*.ts`, `shared/`, `vendor/` | `skills/install-anti-slop/assets/anti-slop/` (the install skill's bundle) | unchanged, but `rules/no-known-value-widening.ts` (below) |
| `rules/*.test.ts` | `src/rules/*.test.ts` | unchanged; `require-readable-spacing-cli.test.ts` is left out, because it runs oxlint through pnpm |
| `index.ts` | the bundle's `index.ts` | local: lists the rules for `../index.js` |
| Effect rules | `effect/` | left out: this repository does not depend on `effect` |

Local choices, kept on update:

- One plugin: `../index.js` registers the rules beside teamai's own, so lint reports `teamai/<rule>`, not `anti-slop/<rule>`. It loads them through `scripts/typescript-loader.mjs`, because CI lints on Node 20.
- Every generic rule and `oxc/no-accumulating-spread` are `"error"` in `.oxlintrc.json`, in production code only. Tests are exempt (the `overrides` entry), because they build partial and malformed values on purpose.
- `.oxlintrc.json` ignores the agent tooling directories the install skill lists (`.claude/**`, `.cursor/**`, …) and the vendored directories above.
- `../anti-slop.test.ts` runs the upstream rule tests under vitest, on Node 22 and later: oxlint's `RuleTester` does not run on Node 20.
- `no-array-filter-map` hits are fixed with `flatMap`, not iterator helpers, which Node 20 lacks.
- `rules/no-known-value-widening.ts` lets a type guard take a wider parameter than an argument's known type when it narrows to a type that argument does not already have (`isJsonObject(value: unknown): value is JsonObject` called with a `JsonValue`), with its three valid cases in `rules/no-known-value-widening.test.ts`. Port it onto an update, or `isJsonObject`'s callers fail lint.

To update, follow the install skill's `references/update.md` with `13909c9e` as the base, then:

```sh
npx vitest run oxlint-plugin-teamai/anti-slop.test.ts
npm run typecheck
npm run lint
```
