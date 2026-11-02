# anti-slop rules

`rules/`, `shared/` and `vendor/` are vendored unchanged from [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) at `13909c9e07590f5a85d93c62712259fe14a883f7` (2026-10-13), MIT (`LICENSE`): every generic rule, without the Effect rules (this repository does not use Effect) and without `require-readable-spacing-cli.test.ts`, which runs oxlint through pnpm. Lint reports them as `teamai/<rule>`, in production code only.

Local files:

- `index.ts` lists the rules by the name the plugin registers.
- `../index.js` loads them through `scripts/typescript-loader.mjs`, because CI lints on Node 20.
- `../anti-slop.test.ts` runs the upstream rule tests under vitest.

To update, copy `src/rules/`, `src/shared/` and `src/vendor/` from a newer upstream revision, then:

```sh
npx vitest run oxlint-plugin-teamai/anti-slop.test.ts
npm run typecheck
npm run lint
```
