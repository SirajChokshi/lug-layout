import type {
  ImportResult,
  ImportWorkerPlaced,
  ImportWorkerRequest,
  ImportWorkerResponse,
  PlacedImport,
} from "@brr/import";
import { IMPORT_PROTOCOL, type BakeHelperHandoff, type RpcEnvelope } from "@brr/rpc";
import { Container } from "inversify";
import { afterEach, expect, it, vi } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { IMPORT_WORKER_POOL } from "../tokens.ts";
import type { ImportRun } from "./import-worker-pool.ts";

const HELPERS = 2;

type Sent = RpcEnvelope<ImportWorkerRequest | BakeHelperHandoff>;

class FakeWorker extends EventTarget {
  readonly received: Sent[] = [];
  terminated = false;

  postMessage(message: Sent): void {
    this.received.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  serves(): boolean {
    return this.received[0]?.body.kind === "serveBakes";
  }

  imports(): Sent[] {
    return this.received.filter((message) => message.body.kind === "import");
  }

  answer(request: Sent, body: ImportWorkerResponse): void {
    const reply: RpcEnvelope<ImportWorkerResponse> = {
      protocol: IMPORT_PROTOCOL.name,
      version: IMPORT_PROTOCOL.version,
      id: request.id + 1_000,
      replyTo: request.id,
      body,
    };
    this.dispatchEvent(new MessageEvent("message", { data: reply }));
  }

  notify(body: ImportWorkerPlaced): void {
    const notice: RpcEnvelope<ImportWorkerPlaced> = {
      protocol: IMPORT_PROTOCOL.name,
      version: IMPORT_PROTOCOL.version,
      id: 2_000,
      replyTo: 0,
      body,
    };
    this.dispatchEvent(new MessageEvent("message", { data: notice }));
  }

  crash(message: string): void {
    this.dispatchEvent(Object.assign(new Event("error"), { message }));
  }
}

function poolOfFakes() {
  const started: FakeWorker[] = [];
  const container = new Container();
  container.load(
    ...mainThreadModules({
      bundleBaseUrl: "unused",
      disclaimer: "unused",
      importBakeHelpers: HELPERS,
      createImportWorker: () => {
        const worker = new FakeWorker();
        started.push(worker);
        return worker as unknown as Worker;
      },
    }),
  );
  const live = () => started.filter((worker) => !worker.terminated);
  const primary = () => {
    const [found] = live().filter((worker) => !worker.serves());
    if (!found) throw new Error("the pool has no primary");
    return found;
  };
  const serving = () => live().filter((worker) => worker.serves());
  return { pool: container.get(IMPORT_WORKER_POOL), started, primary, serving };
}

const run = { compilerUrl: "unused", input: { kind: "ldraw" } } as unknown as ImportRun;

function imported(bakeHelpersFailed: number): ImportWorkerResponse {
  return { kind: "imported", model: { report: { bakeHelpersFailed } } as unknown as ImportResult };
}

function freshHelperPortsBeforeEachImport(primary: FakeWorker): boolean {
  let fresh = false;
  for (const { body } of primary.received) {
    if (body.kind === "useBakeHelpers") fresh = body.ports.length === HELPERS;
    if (body.kind === "import") {
      if (!fresh) return false;
      fresh = false;
    }
  }
  return true;
}

async function settled(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => {
  vi.useRealTimers();
});

it("runs one import at a time and replaces bake helpers only between imports, after a failed helper and after idling", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { pool, primary, serving } = poolOfFakes();

  const first = pool.run(run, []);
  const second = pool.run(run, []);
  await settled();
  const firstHelpers = serving();
  expect(firstHelpers).toHaveLength(HELPERS);
  expect(primary().imports()).toHaveLength(1);

  primary().answer(primary().imports()[0] as Sent, imported(1));
  await first;
  await settled();
  expect(firstHelpers.every((helper) => helper.terminated)).toBe(true);
  const secondHelpers = serving();
  expect(secondHelpers).toHaveLength(HELPERS);
  expect(primary().imports()).toHaveLength(2);

  primary().answer(primary().imports()[1] as Sent, imported(0));
  await second;
  expect(secondHelpers.some((helper) => helper.terminated)).toBe(false);
  vi.runOnlyPendingTimers();
  expect(secondHelpers.every((helper) => helper.terminated)).toBe(true);

  const third = pool.run(run, []);
  await settled();
  expect(serving()).toHaveLength(HELPERS);
  primary().answer(primary().imports()[2] as Sent, imported(0));
  await third;
  expect(freshHelperPortsBeforeEachImport(primary())).toBe(true);
});

it("rejects the import in flight when the primary crashes, and runs the next one on a fresh pool", async () => {
  const { pool, started, primary } = poolOfFakes();

  const crashedImport = pool.run(run, []);
  const nextImport = pool.run(run, []);
  await settled();
  const crashedPool = started.slice();
  crashedPool[0]?.crash("the import worker ran out of memory");

  await expect(crashedImport).rejects.toThrow("the import worker ran out of memory");
  await settled();
  expect(crashedPool.every((worker) => worker.terminated)).toBe(true);
  expect(crashedPool).not.toContain(primary());
  primary().answer(primary().imports()[0] as Sent, imported(0));
  await expect(nextImport).resolves.toMatchObject({ report: { bakeHelpersFailed: 0 } });
});

function placement(name: string): PlacedImport {
  return { partIds: [name] } as unknown as PlacedImport;
}

it("hands each import only the placement its own worker request announced, before its result, and none after it", async () => {
  const { pool, primary } = poolOfFakes();
  const heard: Array<readonly [string, PlacedImport]> = [];
  const first = pool.run(run, [], (placed) => heard.push(["first", placed]));
  const second = pool.run(run, [], (placed) => heard.push(["second", placed]));
  await vi.waitFor(() => expect(primary().imports()).toHaveLength(1));
  const [firstRequest] = primary().imports();
  if (firstRequest?.body.kind !== "import") throw new Error("no first import request");
  const firstTicket = firstRequest.body.ticket;
  primary().notify({ kind: "placed", ticket: firstTicket + 1, placed: placement("stale") });
  primary().notify({ kind: "placed", ticket: firstTicket, placed: placement("a") });
  primary().answer(firstRequest, imported(0));
  await first;
  primary().notify({ kind: "placed", ticket: firstTicket, placed: placement("late") });
  await vi.waitFor(() => expect(primary().imports()).toHaveLength(2));
  const secondRequest = primary().imports()[1];
  if (secondRequest?.body.kind !== "import") throw new Error("no second import request");
  primary().notify({ kind: "placed", ticket: secondRequest.body.ticket, placed: placement("b") });
  primary().answer(secondRequest, imported(0));
  await second;

  expect(heard.map(([name, placed]) => [name, placed.partIds[0]])).toEqual([
    ["first", "a"],
    ["second", "b"],
  ]);
});
