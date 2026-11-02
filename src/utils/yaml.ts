import YAML from 'yaml';

import type { JsonValue } from '../types.js';

/** The warnings the library gives for the YAML 1.1 tags parseYaml reads as what they are written as. */
const READ_AS_WRITTEN = ['set', 'omap', 'pairs', 'binary', 'timestamp'].map((tag) => `Unresolved tag: tag:yaml.org,2002:${tag}`);

/**
 * A YAML document as JSON values. The YAML 1.1 tags `!!set`, `!!omap`, `!!pairs`, `!!binary` and `!!timestamp` stay
 * the mapping, list or string they are written as, instead of becoming a Set, Map, Buffer or Date that a schema over
 * JSON would misread, and without the warning the library prints for each. Every other warning is printed as
 * YAML.parse prints it, and the first error is thrown. An empty document is null.
 */
export function parseYaml(text: string): JsonValue {
  const document = YAML.parseDocument(text, { resolveKnownTags: false });

  for (const warning of document.warnings) {
    if (!READ_AS_WRITTEN.some((message) => warning.message.startsWith(message))) process.emitWarning(warning);
  }

  if (document.errors.length > 0) throw document.errors[0];

  return document.toJS();
}
