// ─── The work under way in each place ───
//
//  A close reads what an open or a launch made, so it waits for the ones under way in its place first; and an open or
//  a launch that ends after the person released the place records nothing there.
//

export interface PlaceWork {
  /** `work`, counted as under way in `handle` until it settles, however it does. */
  track<TValue>(handle: string, work: Promise<TValue>): Promise<TValue>;
  /** Whether the work under way in `handle` settled within `ms`: true at once when there is none. */
  settled(handle: string, ms: number): Promise<boolean>;
  /** The person released `handle`: what ends there later records nothing. */
  release(handle: string): void;
  isReleased(handle: string): boolean;
  /** `handle` is opened again, after a release. */
  reopen(handle: string): void;
}

export function placeWork(): PlaceWork {
  const working = new Map<string, Set<Promise<unknown>>>();
  const released = new Set<string>();

  return {
    track(handle, work) {
      const under = working.get(handle) ?? new Set();
      working.set(handle, under);
      under.add(work);

      const done = (): void => {
        under.delete(work);

        if (under.size === 0 && working.get(handle) === under) working.delete(handle);
      };

      work.then(done, done);

      return work;
    },
    async settled(handle, ms) {
      const under = [...(working.get(handle) ?? [])];

      if (under.length === 0) return true;
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), ms); });

      try {
        return await Promise.race([Promise.allSettled(under).then(() => true as const), late]);
      } finally {
        clearTimeout(timer);
      }
    },
    release: (handle) => { released.add(handle); },
    isReleased: (handle) => released.has(handle),
    reopen: (handle) => { released.delete(handle); },
  };
}
