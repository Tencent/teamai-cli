import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { classifyCopy, type DeliveredFile } from '../resources/delivered-copies.js';

// #822 item 5: pull keeps a copy only when the record proves teamai wrote
// other bytes there than the member has now.
describe('classifyCopy', () => {
  const file = (disk: string | null, recorded: string | undefined, next: string | null): DeliveredFile => (
    { disk, recorded, next }
  );

  it('writes a copy teamai has no record of', () => {
    expect(classifyCopy([file('mine', undefined, 'team')])).toEqual({ kind: 'write' });
  });

  it('writes an untouched copy, and one already at the team version', () => {
    expect(classifyCopy([file('v1', 'v1', 'v2')])).toEqual({ kind: 'write' });
    expect(classifyCopy([file('v2', 'v1', 'v2')])).toEqual({ kind: 'write' });
  });

  it('writes a copy the member deleted, so pull brings the team version back', () => {
    expect(classifyCopy([file(null, 'v1', 'v1')])).toEqual({ kind: 'write' });
    expect(classifyCopy([file(null, 'v1', 'v1'), file(null, 'x1', 'x2')])).toEqual({ kind: 'write' });
  });

  it('keeps an edited copy and says whether the team version moved since', () => {
    expect(classifyCopy([file('edit', 'v1', 'v1')])).toEqual({ kind: 'keep', teamChanged: false });
    expect(classifyCopy([file('edit', 'v1', 'v2')])).toEqual({ kind: 'keep', teamChanged: true });
  });

  it('keeps a whole skill when one file of it was edited or deleted', () => {
    expect(classifyCopy([file('s1', 's1', 's1'), file('edit', 'x1', 'x1')])).toEqual({ kind: 'keep', teamChanged: false });
    expect(classifyCopy([file('s1', 's1', 's1'), file(null, 'x1', 'x1')])).toEqual({ kind: 'keep', teamChanged: false });
    // A file the team added, or removed, since the last delivery is a team change.
    expect(classifyCopy([file('edit', 's1', 's1'), file(null, undefined, 'new')])).toEqual({ kind: 'keep', teamChanged: true });
    expect(classifyCopy([file('edit', 's1', 's1'), file('old', 'old', null)])).toEqual({ kind: 'keep', teamChanged: true });
  });

  it('keeps nothing without proof: only a recorded file whose bytes are neither the record nor the team version', () => {
    const hash = fc.constantFrom('a', 'b', 'c');
    const files = fc.array(fc.record({
      disk: fc.option(hash, { nil: null }),
      recorded: fc.option(hash, { nil: undefined }),
      next: fc.option(hash, { nil: null }),
    }), { maxLength: 4 });
    fc.assert(fc.property(files, (copy) => {
      const proven = copy.some((f) => f.recorded !== undefined && f.disk !== f.recorded && f.disk !== f.next)
        && copy.some((f) => f.disk !== null);
      expect(classifyCopy(copy).kind).toBe(proven ? 'keep' : 'write');
    }));
  });
});
