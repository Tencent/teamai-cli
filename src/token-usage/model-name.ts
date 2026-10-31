/**
 * The name a model is priced under, the same for every spelling a tool or a
 * price list gives it: `anthropic/claude-opus-4.1`,
 * `us.anthropic.claude-opus-4-1-20250805-v1:0` and `claude-opus-4-1[1m]` are
 * all `claude-opus-4-1`. OpenAI's dashed dates (`gpt-4o-2024-05-13`) stay:
 * those snapshots have their own prices.
 */
export function canonicalModelName(model: string): string {
  let name = model.trim().toLowerCase().replace(/\[[^\]]*\]$/, '');
  name = name.slice(name.lastIndexOf('/') + 1);
  return name
    .replace(/^(?:us|eu|apac|au|jp|global|us-gov)\./, '')
    .replace(/^anthropic\./, '')
    .replace(/-v\d+(?::\d+)?$/, '')
    .replace(/[-@]\d{8}$/, '')
    .replace(/(\d)\.(?=\d)/g, '$1-');
}
