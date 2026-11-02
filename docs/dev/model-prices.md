# Model prices

The dashboard prices each request from `src/token-usage/model-prices.json`, built from [LiteLLM's price list](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json). The catalog ships with teamai rather than being fetched at run time: a request's cost is recorded once and kept, so the price it got must come from a version the release names.

## Refresh

The `Model prices` workflow (`.github/workflows/model-prices.yml`) runs every Monday and on demand (Actions → Model prices → Run workflow). When any price changed it pushes `chore/model-prices` and opens or updates one pull request whose body lists the models added, removed and repriced. A new LiteLLM revision that changes no price leaves the catalog as it is and opens nothing:

```text
Model prices from litellm-2026-10-24-a1b2c3d to litellm-2026-10-31-b264711: 3 added, 0 removed, 1 repriced.

| Model | Change | Input | Output | Cache read | Cache write |
| --- | --- | --- | --- | --- | --- |
| claude-opus-5-5 | repriced | $4 | $25 → $20 | $0.2 | $5 |
```

Before it opens the pull request the workflow runs the type check and the pricing tests, because a pull request opened with the default `GITHUB_TOKEN` starts no other workflow. Some tests pin today's prices, such as Opus 5.5 at $4 / $20 per million tokens; when an update changes one, the pull request opens as a draft with the failing output in its body. The fix is to update that expectation on the pull request's branch. While that pull request is open, every run checks its branch: it adds a new catalog on top, so a fix pushed to it stays, and marks the pull request ready once the checks pass, or a draft again when they fail.

To have the full CI run on the pull request, add a repository secret `MODEL_PRICES_TOKEN`: a fine-grained token on this repository with Contents and Pull requests read and write. Without it, the repository setting "Allow GitHub Actions to create and approve pull requests" must be on for the workflow to open the pull request.

To refresh by hand:

```bash
node scripts/update-model-prices.mjs --summary /tmp/model-prices.md
git diff --stat src/token-usage/model-prices.json
```

## How a model gets its price

Every LiteLLM chat model with token prices is keyed by `canonicalModelName` (`src/token-usage/model-name.ts`): `anthropic/claude-opus-4-1`, `us.anthropic.claude-opus-4-1-20250805-v1:0` and `claude-opus-4.1` all become `claude-opus-4-1`. When several entries share a name, the one listed under exactly that name wins; otherwise the price most resellers agree on, and a tie leaves the model unpriced. A member maps any other name with `modelAliases`.
