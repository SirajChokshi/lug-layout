import { decode, decodedOrThrow } from "@brr/schema/decode";
import {
  importRef,
  worldShards,
  type ImportedFile,
  type PlacementRecordV1,
  type WorldHeader,
} from "@brr/schema/world";
import { IDBFactory } from "fake-indexeddb";
import { Container } from "inversify";
import * as v from "valibot";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestHarness, type TestHarness } from "wrangler";
import type { ICloudWorlds } from "./cloud-world-repository.ts";
import { storageModule } from "./storage.module.ts";
import { CLOUD_WORLDS, INDEXED_DB, LAYOUT_API_BASE_URL } from "./tokens.ts";
import { contentSha256 } from "./world-repository.ts";

const API = "http://layout-api.test";
const APP_ORIGIN = "https://layouts.example.test";
const MAIL_FROM = "sign-in@layouts.example.test";
const MAIL_API = "/cdn-cgi/local/explorer/api/local/email/sending";
const layoutApiRoot = new URL("../../../apps/layout-api/", import.meta.url).pathname;

const MailList = v.object({
  result: v.array(v.object({ messageId: v.string(), to: v.array(v.string()) })),
});
const MailDetail = v.object({ result: v.object({ text: v.string() }) });

type HarnessInit = Parameters<TestHarness["fetch"]>[1];

let server: TestHarness;
let reachable = true;
const requests: string[] = [];
const utf8 = new TextEncoder();

beforeAll(async () => {
  server = createTestHarness({
    root: layoutApiRoot,
    workers: [{ configPath: "./wrangler.json", vars: { APP_ORIGIN, MAIL_FROM } }],
  });
  await server.listen();
  const viaHarness = server.fetch.bind(server);
  vi.stubGlobal("fetch", async (input: string, init?: HarnessInit) => {
    if (!reachable) throw new TypeError("fetch failed");
    requests.push(`${init?.method ?? "GET"} ${new URL(input).pathname}`);
    return viaHarness(input, init);
  });
}, 60_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await server.close();
});

async function mailJson<const S extends v.GenericSchema>(
  query: Record<string, string>,
  schema: S,
): Promise<v.InferOutput<S>> {
  const response = await server.fetch(`${MAIL_API}?${new URLSearchParams(query).toString()}`);
  return decodedOrThrow(decode(schema, JSON.parse(await response.text())), "mail explorer");
}

async function mailIdsTo(address: string): Promise<string[]> {
  const listed = await mailJson({ per_page: "100" }, MailList);
  return listed.result.filter((mail) => mail.to.includes(address)).map((mail) => mail.messageId);
}

async function linkFragmentIn(address: string, before: ReadonlyArray<string>): Promise<string> {
  const [fresh] = (await mailIdsTo(address)).filter((id) => !before.includes(id));
  const mail = await mailJson({ email_id: fresh ?? "" }, MailDetail);
  const link = /https?:\/\/\S+/u.exec(mail.result.text)?.[0] ?? "";
  return new URL(link).hash;
}

async function pageLoad(idb: IDBFactory, fragment: string): Promise<ICloudWorlds> {
  const container = new Container();
  container.load(storageModule);
  container.rebind(INDEXED_DB).toConstantValue(idb);
  container.bind(LAYOUT_API_BASE_URL).toConstantValue(API);
  const cloud = container.get(CLOUD_WORLDS);
  await cloud.start(fragment);
  return cloud;
}

async function signedInDevice(email: string, idb = new IDBFactory()): Promise<ICloudWorlds> {
  const beforeSignIn = await pageLoad(idb, "");
  const before = await mailIdsTo(email);
  await beforeSignIn.sendSignInLink(email);
  expect(beforeSignIn.view()).toMatchObject({ signIn: "link-sent", email });
  const fromLink = await pageLoad(idb, await linkFragmentIn(email, before));
  expect(fromLink.view()).toMatchObject({ signIn: "signed-in", email, error: null });
  return fromLink;
}

async function modelFile(name: string, text: string): Promise<ImportedFile> {
  const bytes = utf8.encode(text);
  return { sha256: await contentSha256(bytes), name, bytes };
}

const signalBox = await modelFile(
  "signal box.ldr",
  "0 Signal box\r\n1 4 0 -24 0 1 0 0 0 1 0 0 0 1 3001.dat\r\n1 15 0 -48 0 1 0 0 0 1 0 0 0 1 3003.dat\r\n",
);

const header: WorldHeader = {
  name: "Club show",
  bundleVersion: "e5124ec7210e6f35",
  view: { targetX: 0, targetY: 0, targetZ: 0, distance: 2600, yaw: 0.78, pitch: 0.75 },
  disclaimer: "disclaimer",
};

function baseplateAt(x: number): PlacementRecordV1 {
  return { ref: "ldraw:3811", color: 2, x, z: 0, yPlates: 0, rot: 0 };
}

const signalBoxOnFarTable: PlacementRecordV1 = {
  ref: importRef(signalBox.sha256),
  color: 16,
  x: 40960,
  z: 60,
  yPlates: 1,
  rot: 1,
};

async function createWorld(cloud: ICloudWorlds, placements: ReadonlyArray<PlacementRecordV1>) {
  await cloud.putImportedFile(signalBox);
  const shards = worldShards(placements, []);
  expect(shards).toHaveLength(2);
  return (await cloud.create(header, shards)).id;
}

async function edit(
  cloud: ICloudWorlds,
  id: string,
  placements: ReadonlyArray<PlacementRecordV1>,
  view = header.view,
): Promise<void> {
  const shards = worldShards(placements, []);
  await cloud.save(id, { header: { ...header, view }, put: shards, drop: [] });
}

async function placementsOf(cloud: ICloudWorlds, id: string) {
  const stored = await cloud.read(id);
  return stored.ok ? stored.value.shards.flatMap((shard) => shard.placements) : stored.issues;
}

async function versionNumbers(cloud: ICloudWorlds, id: string): Promise<number[]> {
  return (await cloud.versions(id)).map((version) => version.version);
}

function uploads(kind: "shards" | "imports", sent: ReadonlyArray<string>): string[] {
  return sent.filter((request) => request.startsWith("PUT") && request.includes(`/${kind}/`));
}

function requestsDuring(): () => string[] {
  const start = requests.length;
  return () => requests.slice(start);
}

describe("CloudWorldRepository against the layout API Worker", () => {
  it("uploads a world made before sign-in with its model file, then only what each edit changes, and no version for a camera move", async () => {
    const idb = new IDBFactory();
    const beforeSignIn = await pageLoad(idb, "");
    const id = await createWorld(beforeSignIn, [baseplateAt(0), signalBoxOnFarTable]);
    expect(beforeSignIn.view()).toMatchObject({ signIn: "signed-out", waiting: 0 });

    const firstSync = requestsDuring();
    const cloud = await signedInDevice("builder@example.test", idb);
    await cloud.syncNow();
    expect(uploads("shards", firstSync())).toHaveLength(2);
    expect(uploads("imports", firstSync())).toEqual([
      expect.stringContaining(`/imports/${signalBox.sha256}`),
    ]);
    expect(await cloud.versions(id)).toEqual([
      expect.objectContaining({ version: 1, placements: 2, track: 0, onThisDevice: true }),
    ]);

    const moved = requestsDuring();
    await edit(cloud, id, [baseplateAt(640), signalBoxOnFarTable]);
    expect(cloud.view().waiting).toBe(1);
    await cloud.syncNow();
    expect(uploads("shards", moved())).toHaveLength(1);
    expect(uploads("imports", moved())).toEqual([]);
    expect(cloud.view()).toMatchObject({ sync: "idle", waiting: 0, notice: null });

    const camera = requestsDuring();
    await edit(cloud, id, [baseplateAt(640), signalBoxOnFarTable], { ...header.view, yaw: 2 });
    await cloud.syncNow();
    expect(camera().filter((request) => request.startsWith("POST"))).toEqual([]);
    expect(await versionNumbers(cloud, id)).toEqual([2, 1]);
  });

  it("opens the account's world on a second device, pulls newer saves into its unchanged copy, keeps both sides of a conflict as versions and restores one", async () => {
    const email = "club@example.test";
    const laptop = await signedInDevice(email);
    const local = await createWorld(laptop, [baseplateAt(0), signalBoxOnFarTable]);
    await laptop.syncNow();

    const tablet = await signedInDevice(email);
    await tablet.syncNow();
    const [inAccount] = tablet.view().accountWorlds;
    expect(inAccount?.name).toBe("Club show");
    const shared = inAccount?.id ?? "";
    expect(await placementsOf(tablet, shared)).toEqual([baseplateAt(0), signalBoxOnFarTable]);
    expect((await tablet.importedFile(signalBox.sha256))?.bytes).toEqual(signalBox.bytes);
    expect(tablet.view().accountWorlds).toEqual([]);

    await edit(laptop, local, [baseplateAt(640), signalBoxOnFarTable]);
    await laptop.syncNow();
    expect(await placementsOf(tablet, shared)).toEqual([baseplateAt(640), signalBoxOnFarTable]);

    await edit(tablet, shared, [baseplateAt(1280), signalBoxOnFarTable]);
    await edit(laptop, local, [baseplateAt(1920), signalBoxOnFarTable]);
    await laptop.syncNow();
    expect(await placementsOf(tablet, shared)).toEqual([baseplateAt(1280), signalBoxOnFarTable]);
    await tablet.syncNow();
    expect(tablet.view().notice).toBe(
      '"Club show" was saved on another device (version 3) since this device synced version 2, so this device\'s edits became version 4. Both stay in Versions.',
    );
    expect(await versionNumbers(laptop, local)).toEqual([4, 3, 2, 1]);

    await tablet.restoreVersion(shared, 3);
    expect(await placementsOf(tablet, shared)).toEqual([baseplateAt(1920), signalBoxOnFarTable]);
    expect(await versionNumbers(tablet, shared)).toEqual([5, 4, 3, 2, 1]);
    await laptop.read(local);
    const onLaptop = (await laptop.versions(local)).filter((version) => version.onThisDevice);
    expect(onLaptop.map((version) => version.version)).toEqual([5]);
  });

  it("keeps edits on the device while the API can't be reached and syncs them once it can", async () => {
    const cloud = await signedInDevice("offline@example.test");
    const id = await createWorld(cloud, [baseplateAt(0), signalBoxOnFarTable]);
    await cloud.syncNow();

    reachable = false;
    await edit(cloud, id, [baseplateAt(640), signalBoxOnFarTable]);
    await cloud.syncNow();
    expect(cloud.view()).toMatchObject({ sync: "offline", waiting: 1 });
    expect(await placementsOf(cloud, id)).toEqual([baseplateAt(640), signalBoxOnFarTable]);

    reachable = true;
    await cloud.syncNow();
    expect(cloud.view()).toMatchObject({ sync: "idle", waiting: 0, syncError: null });
    expect(await versionNumbers(cloud, id)).toEqual([2, 1]);
  });
});
