import { describe, expect, it } from 'vitest';
import { FsFailureSchema } from './fs-failure.js';

describe('FsFailureSchema', () => {
  it('reads what the file system says of a path it could not read', () => {
    const error = Object.assign(new Error("EACCES: permission denied, open '/x'"), { code: 'EACCES', path: '/x' });

    expect(FsFailureSchema.safeParse(error)).toMatchObject({ success: true, data: { code: 'EACCES', path: '/x' } });
  });

  it('does not read an error that is not the file system\'s, so no caller takes it for one', () => {
    expect(FsFailureSchema.safeParse(new TypeError('Cannot read properties of undefined')).success).toBe(false);
  });
});
