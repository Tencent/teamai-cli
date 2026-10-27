import path from 'node:path';
import { stat } from 'node:fs/promises';

/** Compare generated handlers without requiring the inspecting CLI's launcher. */
export async function hookSourceMatches(actual: string | null, expected: string): Promise<boolean> {
  if (actual === null) return false;
  if (actual === expected) return true;
  const normalize = (source: string): { body: string; paths: string[]; runtimes: string[] } | null => {
    const paths: string[] = [];
    const runtimes: string[] = [];
    let valid = true;
    const launcher = (encoded: string, runtime = true): void => {
      try {
        const parsed: unknown = JSON.parse(encoded);
        const values: unknown = typeof parsed === 'string' ? [parsed] : parsed;
        if (!Array.isArray(values)
          || !values.every((value): value is string => typeof value === 'string' && path.isAbsolute(value))) {
          valid = false;
        } else {
          paths.push(...values);
          if (runtime && values[0]) runtimes.push(values[0]);
        }
      } catch { valid = false; }
    };
    const jsonString = '"(?:[^"\\\\]|\\\\.)*"';
    let body = source.replace(new RegExp(`^const (NODE|ENTRY) = (${jsonString});$`, 'gm'), (_line, name: string, value: string) => {
      launcher(value, name === 'NODE');
      return `const ${name} = "<installed-launcher>";`;
    });
    body = body.replace(/^const launcher = (\[[^\n]+\]);$/gm, (_line, values: string) => {
      launcher(values);
      return 'const launcher = ["<installed-launcher>"];';
    });
    body = body.replace(new RegExp(`\\[(${jsonString}),\\s*(${jsonString}), "hook-dispatch", "instructions", "--tool", "hermes"\\]`, 'g'), (_line, node: string, entry: string) => {
      launcher(`[${node},${entry}]`);
      return '["<installed-launcher>", "hook-dispatch", "instructions", "--tool", "hermes"]';
    });
    return valid ? { body, paths, runtimes } : null;
  };
  const installed = normalize(actual);
  const current = normalize(expected);
  return installed !== null && current !== null && installed.paths.length > 0
    && installed.paths.length === current.paths.length && installed.body === current.body
    && installed.runtimes.every(file => /^(node(js)?(-\d+)?|bun)(\.exe)?$/i.test(path.basename(file)))
    && (await Promise.all(installed.paths.map(file => stat(file).then(info => info.isFile(), () => false)))).every(Boolean);
}
