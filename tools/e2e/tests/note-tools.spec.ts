import { expect, test, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import {
  noteShardEntry,
  readWorldArchive,
  worldArchiveFiles,
  worldHeader,
  worldManifest,
  type LayerRecordV2,
} from "@brr/schema/world";
import { readZip, writeStoredZip } from "@brr/storage/zip";
import { EditorPage, type LatticePoint } from "./editor-page.ts";

const CC_BY_4 = "Licensed under CC BY 4.0 : see CAreadme.txt";
const KIOSK_FILE = "my-kiosk.ldr";
const USER_KIOSK = [
  "0 My kiosk, a user's own model built from official parts",
  `0 Name: ${KIOSK_FILE}`,
  "0 Author: lug-layout e2e",
  `0 !LICENSE ${CC_BY_4}`,
  "1 2 0 0 0 1 0 0 0 1 0 0 0 1 3036.dat",
  "1 4 0 -8 0 1 0 0 0 1 0 0 0 1 3001.dat",
  "",
].join("\n");
const NOTES_LAYER: LayerRecordV2 = {
  id: 1,
  name: "Notes",
  kind: "notes",
  visible: true,
  locked: false,
  opacity: 100,
};
const NUDGES = 5;
const STUD_LDU = 20;

interface NoteRow {
  readonly id: string;
  readonly note: {
    readonly kind: string;
    readonly text?: string;
    readonly rot?: number;
    readonly outline?: ReadonlyArray<readonly [number, number]>;
    readonly from?: { readonly on: string };
  };
  readonly span: { readonly ax: number; readonly az: number; readonly bx: number } | null;
}

async function noteRows(page: Page): Promise<ReadonlyArray<NoteRow>> {
  const rows: unknown = JSON.parse((await page.locator("#note-state").textContent()) ?? "[]");
  if (!Array.isArray(rows)) throw new Error("#note-state isn't a list of notes");
  return rows.filter((row): row is NoteRow => typeof row === "object" && row !== null);
}

async function giveWorldANotesLayer(page: Page): Promise<void> {
  const menu = page.locator(".world-menu > summary");
  await menu.click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export .brr.zip" }).click();
  const exported = test.info().outputPath("exported.brr.zip");
  await (await download).saveAs(exported);
  const zip = await readZip(new Uint8Array(await readFile(exported)));
  if (!zip.ok) throw new Error("the exported world isn't a zip");
  const texts = new Map(
    [...zip.value].map(([name, bytes]) => [name, new TextDecoder().decode(bytes)]),
  );
  const archive = readWorldArchive(texts);
  if (!archive.ok) throw new Error("the exported world doesn't read back");
  const { manifest, shards, notes, credits } = archive.value;
  const header = { ...worldHeader(manifest), layers: [...manifest.layers, NOTES_LAYER] };
  const files = worldArchiveFiles({
    manifest: worldManifest(header, manifest.shards, notes.map(noteShardEntry)),
    shards,
    notes,
    credits,
  });
  const withLayer = test.info().outputPath("with-notes-layer.brr.zip");
  await writeFile(
    withLayer,
    writeStoredZip(
      files.map(({ name, text }) => ({ name, bytes: new TextEncoder().encode(text) })),
    ),
  );
  const root = page.locator(".editor");
  const exportedWorld = (await root.getAttribute("data-world")) ?? "";
  await page.locator('input[aria-label="Import a .brr.zip world"]').setInputFiles(withLayer);
  await expect(root).not.toHaveAttribute("data-world", exportedWorld);
  await page.locator('.welcome [data-action="start-empty"]').click();
  await expect(page.locator(".welcome")).toHaveCount(0);
  await menu.click();
}

async function clickCorners(editor: EditorPage, corners: ReadonlyArray<LatticePoint>) {
  for (const corner of corners) await editor.clickAt(corner);
}

test("zone, label and ruler tools draw notes through the UI in 3D and the 2D plan, and a ruler drawn onto a user's own model follows it", async ({
  page,
}) => {
  const kioskFile = test.info().outputPath(KIOSK_FILE);
  await writeFile(kioskFile, USER_KIOSK);
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary();
  await giveWorldANotesLayer(page);
  const kiosk = await editor.importModel(kioskFile);
  expect(kiosk.status, kiosk.text).toBe("placeable");
  await editor.placeAt(kiosk.item, { x: 0, z: 0 });
  await editor.escape();
  await editor.zoom(400);

  await editor.press("z");
  await expect(editor.root).toHaveAttribute("data-mode", "zone");
  await editor.dragFrom({ x: -400, z: -200 }, { x: -200, z: -80 });
  await editor.escape();
  await clickCorners(editor, [
    { x: 200, z: -200 },
    { x: 400, z: -200 },
    { x: 400, z: -40 },
  ]);
  await editor.press("Enter");
  await page.screenshot({ path: test.info().outputPath("zones-3d.png") });

  await page.getByRole("button", { name: "2D plan" }).click();
  await editor.goTo({ x: 0, z: 0 });
  await editor.press("n");
  await expect(editor.root).toHaveAttribute("data-mode", "text");
  await editor.clickAt({ x: -300, z: 120 });
  await page.keyboard.type("Ada's kiosk");
  await page.keyboard.press("Enter");
  await editor.press("r");
  await expect(page.locator(".note-texts .note-label text")).toHaveText("Ada's kiosk");

  await editor.press("Shift+U");
  await expect(editor.root).toHaveAttribute("data-mode", "ruler");
  await editor.dragFrom({ x: 0, z: 0 }, { x: 400, z: 0 });
  await page.screenshot({ path: test.info().outputPath("notes-plan.png") });
  const drawn = await noteRows(page);
  await editor.escape();
  await editor.escape();
  expect(await editor.select({ x: 0, z: 0 })).toBe(kiosk.item);
  const before = (await editor.poses()).find((pose) => pose.item === kiosk.item);
  for (let nudge = 0; nudge < NUDGES; nudge++) await editor.press("ArrowRight");
  const after = (await editor.poses()).find((pose) => pose.item === kiosk.item);
  const followed = (await noteRows(page)).find((row) => row.note.kind === "ruler");

  expect(
    drawn.map(({ note, span }) => ({
      kind: note.kind,
      outline: note.outline,
      text: note.text,
      rot: note.rot,
      from: note.from?.on,
      span: note.kind === "ruler" ? span : undefined,
    })),
  ).toEqual([
    {
      kind: "zone",
      outline: [
        [-400, -200],
        [-200, -200],
        [-200, -80],
        [-400, -80],
      ],
    },
    {
      kind: "zone",
      outline: [
        [200, -200],
        [400, -200],
        [400, -40],
      ],
    },
    { kind: "text", text: "Ada's kiosk", rot: 1 },
    { kind: "ruler", from: "model", span: { ax: 0, az: 0, bx: 400, bz: 0 } },
  ]);
  expect(after && before && Math.abs(after.x - before.x) + Math.abs(after.z - before.z)).toBe(
    NUDGES * STUD_LDU,
  );
  expect(followed?.span).toMatchObject({
    ax: (after?.x ?? 0) - (before?.x ?? 0),
    az: (after?.z ?? 0) - (before?.z ?? 0),
    bx: 400,
  });
});
