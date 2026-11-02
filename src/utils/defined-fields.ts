/**
 * `fields` without the ones left undefined, each other in the place it is written: an object that is printed, hashed
 * or written to a file keeps the field order and absence its readers and earlier copies have.
 */
export function definedFields<TFields extends object>(fields: TFields): TFields {
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) Reflect.deleteProperty(fields, key);
  }

  return fields;
}
