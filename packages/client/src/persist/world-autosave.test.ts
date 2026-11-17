import type { IAssetFetcher } from "@brr/catalog";
import { readFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { TRACK_ITEM_ID } from "../edit/editor.ts";
import { EditorHand, headlessContainer, startHeadlessEditor } from "../testing/headless-editor.ts";
import { WORLD_AUTOSAVE, WORLD_STORE } from "../tokens.ts";
import { AUTOSAVE_WORLD } from "./world-autosave.ts";
import type { IWorldStore, StoredWorld, WorldWrite } from "./world-store.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);

const bundleFiles: IAssetFetcher = {
  async bytes(path: string): Promise<ArrayBuffer> {
    const buffer = await readFile(new URL(path, bundleRoot));
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  },
  text: (path: string) => readFile(new URL(path, bundleRoot), "utf8"),
};

const DISCLAIMER = "Not affiliated with the LEGO Group.";
const BASEPLATE_PART = "ldraw:3811";

class MemoryWorldStore implements IWorldStore {
  readonly worlds = new Map<string, { files: Map<string, string>; savedAt: number }>();
  readonly writes: WorldWrite[] = [];

  constructor(private readonly ownsAutosave = true) {}

  async claim(): Promise<boolean> {
    return this.ownsAutosave;
  }

  async read(world: string): Promise<StoredWorld | null> {
    const stored = this.worlds.get(world);
    return stored ? { files: new Map(stored.files), savedAt: stored.savedAt } : null;
  }

  async write(world: string, write: WorldWrite): Promise<void> {
    const stored = this.worlds.get(world) ?? { files: new Map<string, string>(), savedAt: 0 };
    for (const name of write.remove) stored.files.delete(name);
    for (const { name, text } of write.put) stored.files.set(name, text);
    stored.savedAt = write.savedAt;
    this.worlds.set(world, stored);
    this.writes.push(write);
  }

  async move(from: string, to: string): Promise<void> {
    const stored = this.worlds.get(from);
    if (!stored) return;
    this.worlds.set(to, stored);
    this.worlds.delete(from);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function session(store: IWorldStore) {
  vi.stubGlobal("requestAnimationFrame", () => 0);
  const container = headlessContainer(bundleFiles, []);
  container.rebind(WORLD_STORE).toConstantValue(store);
  const { editor } = await startHeadlessEditor(container);
  const autosave = container.get(WORLD_AUTOSAVE);
  await autosave.start(DISCLAIMER);
  const baseplate = editor.snapshot().catalog.find((item) => item.group === BASEPLATE_PART)?.id;
  if (!baseplate) throw new Error(`the catalog offers no ${BASEPLATE_PART}`);
  return { editor, autosave, baseplate, hand: new EditorHand(editor) };
}

async function buildTown(store: IWorldStore) {
  const opened = await session(store);
  const { editor, hand, baseplate } = opened;
  editor.chooseItem(baseplate);
  hand.click(0, 0);
  hand.click(640, 0);
  editor.chooseItem(TRACK_ITEM_ID);
  hand.drag([-300, 0], [620, 0]);
  hand.drag([-140, 0], [-140, 0]);
  editor.deleteSelection(hand.time());
  editor.chooseItem(null);
  await opened.autosave.flush();
  return opened;
}

it("autosaves the edits, and a fresh session reopens them byte-identical with nothing to undo", async () => {
  const store = new MemoryWorldStore();
  const first = await buildTown(store);
  const built = first.editor.worldRecords();
  expect(built.placements).toHaveLength(2);
  expect(built.track.length).toBeGreaterThan(0);
  expect(first.autosave.snapshot().state).toBe("saved");
  const writes = store.writes.length;

  const second = await session(store);
  expect(second.autosave.snapshot().restored).toMatchObject({
    placements: 2,
    track: built.track.length,
    exact: true,
  });
  expect(second.editor.worldRecords()).toEqual(built);
  expect(second.editor.snapshot().history.undo).toBeNull();
  await second.autosave.flush();
  expect(store.writes).toHaveLength(writes);
}, 120_000);

it("rewrites only the manifest and the shards an edit touched", async () => {
  const store = new MemoryWorldStore();
  const { editor, hand, baseplate, autosave } = await buildTown(store);
  const before = new Map(store.worlds.get(AUTOSAVE_WORLD)?.files);

  editor.chooseItem(baseplate);
  hand.click(6400, 0);
  await autosave.flush();

  const written = store.writes.at(-1);
  const after = store.worlds.get(AUTOSAVE_WORLD)?.files ?? new Map<string, string>();
  const changed = [...after.keys()].filter((name) => before.get(name) !== after.get(name));
  expect(written?.put.map((file) => file.name).toSorted()).toEqual(changed.toSorted());
  expect(changed.toSorted()).toEqual(["manifest.json", "shards/1_0.json"]);
}, 120_000);

it("keeps an autosave it cannot open aside, untouched, and starts a new layout", async () => {
  const store = new MemoryWorldStore();
  const unreadable = new Map([
    ["manifest.json", "{"],
    ["CREDITS.txt", "credits"],
  ]);
  store.worlds.set(AUTOSAVE_WORLD, { files: new Map(unreadable), savedAt: 5 });

  const { editor, autosave, baseplate, hand } = await session(store);
  expect(autosave.snapshot().setAside).toMatchObject({ as: "unreadable-5" });
  expect(store.worlds.get("unreadable-5")?.files).toEqual(unreadable);
  expect(editor.worldRecords().placements).toHaveLength(0);

  editor.chooseItem(baseplate);
  hand.click(0, 0);
  await autosave.flush();
  expect(store.worlds.get(AUTOSAVE_WORLD)?.files.get("manifest.json")).toContain('"placements":1');
  expect(store.worlds.get("unreadable-5")?.files).toEqual(unreadable);
}, 120_000);

it("never writes from a second tab while another tab holds the autosave", async () => {
  const store = new MemoryWorldStore(false);
  const { editor, autosave, baseplate, hand } = await session(store);
  expect(autosave.snapshot().state).toBe("elsewhere");

  editor.chooseItem(baseplate);
  hand.click(0, 0);
  await autosave.flush();
  expect(store.writes).toHaveLength(0);
}, 120_000);
