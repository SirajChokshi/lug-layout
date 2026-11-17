import { injectable } from "inversify";

export interface WorldLease {
  readonly exclusive: boolean;
  readonly whenExclusive: Promise<void>;
  release(): void;
}

export interface IWorldLocks {
  hold(id: string): Promise<WorldLease>;
}

const WORLD_LOCK_PREFIX = "brr-world-";

const IGNORE = (): void => undefined;

class Signal {
  resolve: () => void = IGNORE;
  readonly promise = new Promise<void>((done) => {
    this.resolve = done;
  });
}

@injectable()
export class WebWorldLocks implements IWorldLocks {
  async hold(id: string): Promise<WorldLease> {
    const locks = globalThis.navigator?.locks;
    const held = new Signal();
    if (!locks) return { exclusive: true, whenExclusive: Promise.resolve(), release: held.resolve };
    const name = `${WORLD_LOCK_PREFIX}${id}`;
    const granted = await new Promise<boolean>((resolve) => {
      void locks.request(name, { ifAvailable: true }, async (lock) => {
        resolve(lock !== null);
        if (lock !== null) await held.promise;
      });
    });
    if (granted)
      return { exclusive: true, whenExclusive: Promise.resolve(), release: held.resolve };
    const exclusive = new Signal();
    const waiting = new AbortController();
    locks
      .request(name, { signal: waiting.signal }, async () => {
        exclusive.resolve();
        await held.promise;
      })
      .catch(() => undefined);
    return {
      exclusive: false,
      whenExclusive: exclusive.promise,
      release: () => {
        waiting.abort();
        held.resolve();
      },
    };
  }
}
