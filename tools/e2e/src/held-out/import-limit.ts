import { Worker } from "node:worker_threads";
import type { HeldOutInput, ImportOutcome } from "./import-path.ts";

const IMPORT_THREAD = new URL("./import-thread.ts", import.meta.url);
const THREAD_NODE_OPTIONS = ["--experimental-transform-types", "--no-warnings"];
const MS_PER_SECOND = 1000;

export type LimitedOutcome =
  | ImportOutcome
  | { readonly kind: "unfinished"; readonly limitSeconds: number };

interface Settled {
  readonly outcome: LimitedOutcome;
  readonly threadAlive: boolean;
}

function threadFailure(message: string): Settled {
  return { outcome: { kind: "threw", message }, threadAlive: false };
}

interface ThreadRoots {
  readonly bundle: string;
  readonly ldrawCache: string;
  readonly records: string;
  readonly libraryConnectors: string;
}

function startThread(roots: ThreadRoots): Promise<Worker> {
  const worker = new Worker(IMPORT_THREAD, {
    argv: [roots.bundle, roots.ldrawCache, roots.records, roots.libraryConnectors],
    execArgv: THREAD_NODE_OPTIONS,
  });
  worker.unref();
  return new Promise((resolve, reject) => {
    worker.once("error", reject);
    worker.once("message", () => {
      worker.off("error", reject);
      resolve(worker);
    });
  });
}

function settledReply(worker: Worker, limitSeconds: number): Promise<Settled> {
  return new Promise((resolve) => {
    const settle = (settled: Settled): void => {
      clearTimeout(limit);
      for (const event of ["message", "error", "exit"]) worker.removeAllListeners(event);
      resolve(settled);
    };
    const limit = setTimeout(
      () => settle({ outcome: { kind: "unfinished", limitSeconds }, threadAlive: false }),
      limitSeconds * MS_PER_SECOND,
    );
    worker
      .on("message", (outcome: ImportOutcome) => settle({ outcome, threadAlive: true }))
      .on("error", (error: Error) => settle(threadFailure(error.message)))
      .on("exit", (code: number) =>
        settle(threadFailure(`the import thread exited with code ${code}`)),
      );
  });
}

export function importsWithinLimit(roots: ThreadRoots, limitSeconds: number) {
  let thread: Promise<Worker> | null = null;
  return {
    async run(input: HeldOutInput): Promise<{ outcome: LimitedOutcome; seconds: number }> {
      thread ??= startThread(roots);
      const worker = await thread;
      const started = performance.now();
      worker.postMessage(input, []);
      const { outcome, threadAlive } = await settledReply(worker, limitSeconds);
      const seconds = (performance.now() - started) / MS_PER_SECOND;
      if (!threadAlive) {
        thread = null;
        await worker.terminate();
      }
      return { outcome, seconds };
    },
    async close(): Promise<void> {
      const running = thread;
      thread = null;
      if (running) await (await running).terminate();
    },
  };
}
