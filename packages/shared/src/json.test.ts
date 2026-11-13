import { describe, expect, expectTypeOf, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { isJsonObject, type JsonObject } from './json.js';

describe('isJsonObject', () => {
  it('takes what JSON and YAML parse an object to, null-prototype documents and YAML\'s .inf and .nan among them', () => {
    expect(isJsonObject(JSON.parse('{"a":[1,"x",true,null,{"b":{}}],"__proto__":{"c":1}}'))).toBe(true);
    expect(isJsonObject(parseYaml('limit: .inf\nratio: .nan\nnested: { list: [1, two] }\n'))).toBe(true);
    expect(isJsonObject(Object.assign(Object.create(null), { a: 1 }))).toBe(true);
  });

  it('takes an object a caller built, with a field left undefined or nested thousands of levels deep, as it stands', () => {
    let deep: JsonObject = { leaf: 1 };
    for (let level = 0; level < 10_000; level++) deep = { deep };

    expect(isJsonObject({ scorer: 'review', requests: undefined })).toBe(true);
    expect(isJsonObject(deep)).toBe(true);
  });

  it('refuses arrays, primitives, null and undefined', () => {
    for (const value of [[], 'x', 1, true, null, undefined]) expect(isJsonObject(value)).toBe(false);
  });

  it('refuses an object no parser makes', () => {
    for (const value of [new Date(), new Map(), () => {}, new (class Point { x = 1; })()]) expect(isJsonObject(value)).toBe(false);
  });

  it('narrows unparsed input, so data from a file needs no annotation first', () => {
    const read: unknown = JSON.parse('{"name":"x"}');

    if (isJsonObject(read)) expectTypeOf(read).toEqualTypeOf<JsonObject>();
  });
});
