import fs from 'node:fs';
import { parseDocument } from 'yaml';
import { z } from 'zod';

const RecipeSchema = z.object({
  jobs: z.record(z.object({
    'runs-on': z.string().optional(),
    env: z.record(z.string()).optional(),
    steps: z.array(z.object({ uses: z.string().optional(), with: z.record(z.unknown()).optional(), run: z.string().optional() })),
  })),
});
export type CiRecipe = z.infer<typeof RecipeSchema>;

/** Each GitHub Actions workflow the page at `file` shows: a yaml fence whose document has `jobs`. */
export function ciRecipesOf(file: string): CiRecipe[] {
  const text = fs.readFileSync(file, 'utf8');
  return [...text.matchAll(/^```yaml\n([\s\S]*?)^```/gm)].flatMap((match) => {
    const value: unknown = parseDocument(match[1] ?? '').toJS();
    return value && typeof value === 'object' && 'jobs' in value ? [RecipeSchema.parse(value)] : [];
  });
}

/** The `run:` commands of every job in `recipe`, in order. */
export function runCommandsOf(recipe: CiRecipe): string[] {
  return Object.values(recipe.jobs).flatMap((job) => job.steps.flatMap((step) => (step.run === undefined ? [] : [step.run])));
}
