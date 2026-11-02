import YAML from 'yaml';

import type { JsonValue } from '../types.js';

/**
 * A YAML document as JSON values. The YAML 1.1 tags `!!set`, `!!omap`, `!!pairs`, `!!binary` and `!!timestamp` stay
 * the mapping, list or string they are written as, instead of becoming a Set, Map, Buffer or Date that a schema over
 * JSON would misread, and without the warning the library prints for each. An empty document is null.
 */
export function parseYaml(text: string): JsonValue {
  return YAML.parse(text, { resolveKnownTags: false, logLevel: 'error' });
}
