import type { IAssetFetcher } from "@brr/catalog";
import { readFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { EditorHand, headlessContainer, startHeadlessEditor } from "../testing/headless-editor.ts";
import { TRACK_ITEM_ID, type IEditor } from "./editor.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);

const bundleFiles: IAssetFetcher = {
  async bytes(path: string): Promise<ArrayBuffer> {
    const buffer = await readFile(new URL(path, bundleRoot));
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  },
  text: (path: string) => readFile(new URL(path, bundleRoot), "utf8"),
};

const PLACEABLE_SET = "7936-1";
const STUDLESS_SET = "10016-1";
const BASEPLATE_PART = "ldraw:3811";

afterEach(() => {
  vi.unstubAllGlobals();
});

function startEditor(models: ReadonlyArray<string> = [PLACEABLE_SET, STUDLESS_SET]) {
  vi.stubGlobal("requestAnimationFrame", () => 0);
  return startHeadlessEditor(headlessContainer(bundleFiles, models));
}

it("starts with a stud-less set in the bundle, leaving it out of the catalog and reporting it as skipped", async () => {
  const { editor } = await startEditor();

  const snapshot = editor.snapshot();
  expect(snapshot.error).toBeNull();
  expect(snapshot.status).toBe("ready");
  const ids = snapshot.catalog.map((item) => item.id);
  expect(ids).toContain(`omr:${PLACEABLE_SET}`);
  expect(ids).not.toContain(`omr:${STUDLESS_SET}`);
  expect(snapshot.catalogSkipped).toEqual([
    { name: STUDLESS_SET, reason: "no stud lattice from the bake" },
  ]);
  expect(snapshot.credits?.models.map((credit) => credit.name)).toContain(STUDLESS_SET);
}, 120_000);

it("offers every baseplate and road plate in exactly the produced colours the bundle lists", async () => {
  const { editor, manifest } = await startEditor();

  const { catalog } = editor.snapshot();
  const catalogParts = manifest.parts.filter((p) => p.role === "ground" || p.role === "road");
  expect(catalogParts.length).toBeGreaterThan(0);
  const offered = catalogParts.map((part) => [
    part.id,
    catalog.filter((item) => item.group === part.id).map((item) => item.color?.code),
  ]);
  const produced = catalogParts.map((part) => [
    part.id,
    part.producedColors?.colors.map((color) => color.ldraw),
  ]);
  expect(offered).toEqual(produced);
}, 120_000);

function layoutState(editor: IEditor): unknown {
  const dump = editor.dump();
  const rows = dump.placements.refId.map((refId, i) =>
    [
      dump.refs[refId],
      dump.placements.colorId[i],
      dump.placements.x[i],
      dump.placements.z[i],
      dump.placements.yPlates[i],
      dump.placements.rot[i],
    ].join(","),
  );
  const track = editor.snapshot().track;
  return {
    placements: rows.toSorted(),
    track: dump.track,
    openEnds: track?.openEnds,
    joins: track?.joins,
    studs: dump.studs,
  };
}

it("makes every gesture one undo step, and undo then redo walk back and forth through the exact layouts", async () => {
  const { editor } = await startEditor([]);
  const states = [layoutState(editor)];
  const hand = new EditorHand(editor);
  const gesture = (act: () => void): void => {
    const depth = editor.snapshot().history.undoDepth;
    act();
    expect(editor.snapshot().lastRefusal).toBeNull();
    expect(editor.snapshot().history.undoDepth).toBe(depth + 1);
    states.push(layoutState(editor));
  };
  const click = (x: number, z: number): void => hand.click(x, z);
  const drag = (from: readonly [number, number], to: readonly [number, number]): void => {
    expect(hand.drag(from, to)).toBe(true);
  };

  const baseplate = editor.snapshot().catalog.find((item) => item.group === BASEPLATE_PART)?.id;
  if (!baseplate) throw new Error(`the catalog offers no ${BASEPLATE_PART}`);
  editor.chooseItem(baseplate);
  gesture(() => click(0, 0));
  gesture(() => click(640, 0));
  gesture(() => click(0, 640));
  editor.chooseItem(TRACK_ITEM_ID);
  gesture(() => drag([-320, 0], [320, 0]));
  gesture(() => drag([320, 0], [900, 220]));
  drag([-160, 0], [-160, 0]);
  expect(editor.snapshot().track?.selected).not.toBeNull();
  gesture(() => editor.deleteSelection(hand.time()));
  editor.chooseItem(null);
  click(0, 640);
  expect(editor.snapshot().selection?.item).toBe(baseplate);
  gesture(() => editor.rotate(hand.time()));
  gesture(() => editor.deleteSelection(hand.time()));
  gesture(() => editor.clearWorld(hand.time()));

  for (let step = 1; step < states.length; step++) {
    expect(states[step]).not.toEqual(states[step - 1]);
  }
  for (let depth = states.length - 2; depth >= 0; depth--) {
    editor.undo(hand.time());
    expect(layoutState(editor)).toEqual(states[depth]);
  }
  expect(editor.snapshot().history.undo).toBeNull();
  for (let depth = 1; depth < states.length; depth++) {
    editor.redo(hand.time());
    expect(layoutState(editor)).toEqual(states[depth]);
  }
  expect(editor.snapshot().history.redo).toBeNull();
}, 120_000);
