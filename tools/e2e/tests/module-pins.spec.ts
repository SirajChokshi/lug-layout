import { expect, test, type Page } from "@playwright/test";
import { randomInt } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openBundleParts } from "../src/held-out/bundle.ts";
import {
  fromLdrawFrame,
  hitIsReal,
  pinHoleJoints,
  pinsOf,
  posed,
} from "../src/held-out/editor-pairs.ts";
import { blockPools, modulePair, type ModulePair } from "../src/held-out/generator.ts";
import { cachingFetch } from "../src/held-out/import-path.ts";
import { poolCandidates } from "../src/held-out/pool-candidates.ts";
import { EditorPage, STUD } from "./editor-page.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BUNDLE_ROOT = join(REPO_ROOT, "tools/asset-pipeline/dist/bundle");
const SEED_RANGE = 2 ** 31;
const GENERATOR_ATTEMPTS = 8;
const FIRST_STEP_BEYOND_RADIUS = 3;

type Vec3 = readonly [number, number, number];

function seed(): number {
  const given = process.env["HELD_OUT_SEED"];
  return given === undefined || given === "" ? randomInt(SEED_RANGE) : Number(given);
}

async function generatedPair(from: number): Promise<ModulePair> {
  const bundle = await openBundleParts(BUNDLE_ROOT);
  const fetchUrl = cachingFetch(join(REPO_ROOT, ".cache/held-out/ldraw"));
  const pools = blockPools(
    await poolCandidates(bundle, fetchUrl),
    bundle.parts.values(),
    bundle.colors,
  );
  for (let next = from; next < from + GENERATOR_ATTEMPTS; next++) {
    try {
      return modulePair(pools, next % SEED_RANGE);
    } catch {
      continue;
    }
  }
  throw new Error(`no module pair from seeds ${from} to ${from + GENERATOR_ATTEMPTS - 1}`);
}

async function freshPair(): Promise<ModulePair> {
  const base = seed();
  const pair = await generatedPair(base);
  test.info().annotations.push({
    type: "seed",
    description: `HELD_OUT_SEED=${base} (pair seed ${pair.seed})`,
  });
  process.stdout.write(`module-pins seed ${base}: HELD_OUT_SEED=${base} reproduces it\n`);
  return pair;
}

async function importModels(
  page: Page,
  models: ReadonlyArray<{ readonly names: { readonly file: string }; readonly text: string }>,
): Promise<{ readonly editor: EditorPage; readonly items: ReadonlyArray<string> }> {
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary();
  const items: string[] = [];
  for (const model of models) {
    const file = test.info().outputPath(model.names.file);
    await writeFile(file, model.text);
    const imported = await editor.importModel(file);
    expect(imported.status, imported.text).toBe("placeable");
    items.push(imported.item);
  }
  return { editor, items };
}

async function placedAtOrigin(editor: EditorPage, item: string) {
  await editor.placeAt(item, { x: 0, z: 0 });
  const [placed] = await editor.poses();
  if (!placed) throw new Error(`${item} wasn't placed`);
  return placed;
}

async function flushBeside(
  editor: EditorPage,
  placed: {
    readonly item: string;
    readonly x: number;
    readonly z: number;
    readonly yPlates: number;
  },
  heldItem: string,
  fileOffset: Vec3,
) {
  const placedShift = await editor.frameShift(placed.item);
  const heldShift = await editor.frameShift(heldItem);
  const offset = fromLdrawFrame(fileOffset);
  return {
    placedShift,
    heldShift,
    flush: {
      x: placed.x + placedShift[0] + offset[0] - heldShift[0],
      z: placed.z + placedShift[2] + offset[2] - heldShift[2],
      yPlates: placed.yPlates,
      rot: 0,
    },
    toward: { x: -Math.sign(offset[0]) * STUD, z: -Math.sign(offset[2]) * STUD },
  };
}

test("a freshly generated holed module snaps flush onto a pinned one through the editor's UI, and is refused beyond the pick radius", async ({
  page,
}) => {
  const pair = await freshPair();
  const { editor, items } = await importModels(page, [pair.subject, pair.partner]);
  const [subject = "", partner = ""] = items;
  const placed = await placedAtOrigin(editor, subject);
  const { placedShift, heldShift, flush, toward } = await flushBeside(
    editor,
    placed,
    partner,
    pair.partnerOffset,
  );
  const at = (studs: number) => ({ x: flush.x + studs * toward.x, z: flush.z + studs * toward.z });

  for (const studs of [-1, 1]) {
    const point = await editor.hoverPlacementAt(partner, at(studs));
    const hover = await editor.hoverPlacement();
    expect(hover?.accepted, `seed ${pair.seed}: ${studs} stud(s) toward the pins is accepted`).toBe(
      true,
    );
    expect(hover?.pose, `seed ${pair.seed}: it snaps flush`).toEqual(flush);
    expect(
      hover ? pinHoleJoints(hover.mates) : 0,
      `seed ${pair.seed}: every pin engages a hole`,
    ).toBe(pair.pins);
    await page.mouse.click(point.sx, point.sy);
    await expect.poll(() => editor.poses()).toContainEqual({ item: partner, ...flush });
    await editor.undo();
  }

  const point = await editor.hoverPlacementAt(partner, at(FIRST_STEP_BEYOND_RADIUS));
  const refused = await editor.hoverPlacement();
  expect(
    refused?.accepted,
    `seed ${pair.seed}: ${FIRST_STEP_BEYOND_RADIUS} studs in is refused`,
  ).toBe(false);
  expect(refused?.hit?.placed.item, `seed ${pair.seed}: the hit names the pinned module`).toBe(
    subject,
  );
  expect(
    refused !== null &&
      hitIsReal(
        refused.hit,
        subject,
        posed(pair.subject.assembly, placed, placedShift),
        posed(pair.partner.assembly, refused.pose, heldShift),
      ),
    `seed ${pair.seed}: the hit (${JSON.stringify(refused?.hit)}) names a part of the pinned module where the two overlap`,
  ).toBe(true);
  await page.mouse.click(point.sx, point.sy);
  expect(await editor.poses()).toEqual([placed]);
});

test("a freshly generated pinned module held flush against solid bricks is refused through the editor's UI, naming the brick and cell the pins hit", async ({
  page,
}) => {
  const pair = await freshPair();
  const { editor, items } = await importModels(page, [pair.solidPartner, pair.subject]);
  const [solid = "", subject = ""] = items;
  const placed = await placedAtOrigin(editor, solid);
  const heldOffset: Vec3 = [
    0 - pair.partnerOffset[0],
    0 - pair.partnerOffset[1],
    0 - pair.partnerOffset[2],
  ];
  const { placedShift, heldShift, flush } = await flushBeside(editor, placed, subject, heldOffset);

  const point = await editor.hoverPlacementAt(subject, flush);
  const hover = await editor.hoverPlacement();
  expect(hover?.accepted, `seed ${pair.seed}: pins against solid bricks are refused`).toBe(false);
  expect(hover?.pose, `seed ${pair.seed}: it stays where it was aimed`).toEqual(flush);
  expect(hover ? pinHoleJoints(hover.mates) : -1, `seed ${pair.seed}: no pin finds a hole`).toBe(0);
  expect(
    hover !== null &&
      hitIsReal(
        hover.hit,
        solid,
        posed(pair.solidPartner.edgeRow, placed, placedShift),
        posed(pinsOf(pair.subject.assembly), hover.pose, heldShift),
      ),
    `seed ${pair.seed}: the hit (${JSON.stringify(hover?.hit)}) names a brick on the solid edge and a cell it covers`,
  ).toBe(true);
  await page.mouse.click(point.sx, point.sy);
  expect(await editor.poses()).toEqual([placed]);
});
