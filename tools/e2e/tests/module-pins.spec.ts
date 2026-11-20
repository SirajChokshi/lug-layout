import type { PlacementMode } from "@brr/client";
import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Assembly } from "../src/held-out/assembly.ts";
import { openBundleParts } from "../src/held-out/bundle.ts";
import {
  fromLdrawFrame,
  hitIsReal,
  pinHoleJoints,
  pinsOf,
  placementVerdict,
  posed,
  sameDistance,
} from "../src/held-out/editor-pairs.ts";
import { blockPools, modulePair, type ModulePair } from "../src/held-out/generator.ts";
import { poolCandidates } from "../src/held-out/pool-candidates.ts";
import {
  byPosition,
  EditorPage,
  pinnedLdrawFetch,
  STUD,
  type DumpedPlacementHover,
  type HoverState,
  type Pose,
  type ScreenPoint,
} from "./editor-page.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BUNDLE_ROOT = join(REPO_ROOT, "tools/asset-pipeline/dist/bundle");
const SEED_RANGE = 2 ** 31;
const DEFAULT_SEED = 7;
const GENERATOR_ATTEMPTS = 8;
const TOGGLE_KEY = "a";
const ASSIST_FLOOR_LDU = STUD;
const ASSIST_CAP_LDU = 3 * STUD;
const ZOOM_STEP_IN = -150;
const ZOOM_STEP_OUT = 150;
const ZOOM_STEPS = 24;
const HOLD_KEY = "Alt";
const BASEPLATE = "ldraw:3811@2";
const MARKET_STREET = "omr:10190-1";
const PET_SHOP = "omr:10218-1";
const GROCER = "omr:10185-1";
const RELOCATING_GAP_STUDS = 2;
const WEST_FACE_PIN_JOINTS = 2;

type Vec3 = readonly [number, number, number];

interface Placed {
  readonly item: string;
  readonly x: number;
  readonly z: number;
  readonly yPlates: number;
  readonly rot: number;
}

interface LatticePose {
  readonly x: number;
  readonly z: number;
  readonly yPlates: number;
  readonly rot: number;
}

interface Seam {
  readonly placedShift: Vec3;
  readonly heldShift: Vec3;
  readonly flush: LatticePose;
  cursorAt(along: number, across: number): { readonly x: number; readonly z: number };
}

function seed(): number {
  const given = process.env["HELD_OUT_SEED"];
  if (given === undefined || given === "") return DEFAULT_SEED;
  const value = Number(given);
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`HELD_OUT_SEED ${given} is not a seed`);
  return value;
}

async function generatedPair(from: number): Promise<ModulePair> {
  const bundle = await openBundleParts(BUNDLE_ROOT);
  const pools = blockPools(
    await poolCandidates(bundle, pinnedLdrawFetch()),
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

async function placedAtOrigin(editor: EditorPage, item: string): Promise<Placed> {
  await editor.placeAt(item, { x: 0, z: 0 });
  const [placed] = await editor.poses();
  if (!placed) throw new Error(`${item} wasn't placed`);
  return placed;
}

async function seamBeside(
  editor: EditorPage,
  placed: Placed,
  heldItem: string,
  fileOffset: Vec3,
  fileAlong: Vec3,
): Promise<Seam> {
  const placedShift = await editor.frameShift(placed.item);
  const heldShift = await editor.frameShift(heldItem);
  const offset = fromLdrawFrame(fileOffset);
  const along = fromLdrawFrame(fileAlong);
  const toward = { x: -Math.sign(offset[0]) * STUD, z: -Math.sign(offset[2]) * STUD };
  const flush = {
    x: placed.x + placedShift[0] + offset[0] - heldShift[0],
    z: placed.z + placedShift[2] + offset[2] - heldShift[2],
    yPlates: placed.yPlates,
    rot: 0,
  };
  return {
    placedShift,
    heldShift,
    flush,
    cursorAt: (alongStuds, acrossStuds) => ({
      x: flush.x + alongStuds * along[0] + acrossStuds * toward.x,
      z: flush.z + alongStuds * along[2] + acrossStuds * toward.z,
    }),
  };
}

async function expectMode(
  editor: EditorPage,
  persistent: PlacementMode,
  effective: PlacementMode,
  held: boolean,
): Promise<void> {
  const control = editor.placementSwitch();
  await expect(control).toHaveAttribute(
    "aria-checked",
    persistent === "precise" ? "true" : "false",
  );
  await expect(control).toHaveAttribute("data-effective-mode", effective);
  if (held) await expect(control).toHaveAttribute("data-held", /.*/);
  else await expect(control).not.toHaveAttribute("data-held", /.*/);
  await expect(control).toHaveAttribute("data-placement-mode", persistent);
  await expect.poll(() => editor.placementModes()).toEqual({ mode: persistent, override: held });
  await editor.hoverIn(effective);
}

function realHit(
  hover: HoverState,
  placedItem: string,
  named: Assembly,
  held: Assembly,
  placed: Placed,
  seam: Seam,
): boolean {
  const placement = hover.placement;
  return (
    placement !== null &&
    !placement.accepted &&
    hitIsReal(
      placement.hit,
      placedItem,
      posed(named, placed, seam.placedShift),
      posed(held, placement.pose, seam.heldShift),
    )
  );
}

function atCursor(hover: HoverState): boolean {
  const placement = hover.placement;
  return (
    placement !== null &&
    !placement.magnetised &&
    placement.pose.x === hover.x &&
    placement.pose.z === hover.z &&
    placement.pose.yPlates === hover.yPlates
  );
}

test("a generated holed module snaps flush onto a pinned one in assist mode and sits exactly at the cursor in precise mode; the mode switches by key, by the switch, and while Alt is held", async ({
  page,
}) => {
  const pair = await freshPair();
  const { editor, items } = await importModels(page, [pair.subject, pair.partner]);
  const [subject = "", partner = ""] = items;
  const placed = await placedAtOrigin(editor, subject);
  const seam = await seamBeside(editor, placed, partner, pair.partnerOffset, pair.alongEdge);
  await editor.goTo(seam.flush);
  const short = seam.cursorAt(0, -1);
  const hit = (hover: HoverState): boolean =>
    realHit(hover, subject, pair.subject.assembly, pair.partner.assembly, placed, seam);

  await editor.hoverPlacementAt(partner, short);
  await expectMode(editor, "assist", "assist", false);
  await editor.page.keyboard.press(TOGGLE_KEY);
  await expectMode(editor, "precise", "precise", false);
  await editor.placementSwitch().click();
  await editor.hoverPlacementAt(partner, short);
  await expectMode(editor, "assist", "assist", false);
  await page.keyboard.down(HOLD_KEY);
  await expectMode(editor, "assist", "precise", true);
  await page.keyboard.up(HOLD_KEY);
  await expectMode(editor, "assist", "assist", false);
  await page.keyboard.down(HOLD_KEY);
  await expectMode(editor, "assist", "precise", true);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expectMode(editor, "assist", "assist", false);
  await page.keyboard.up(HOLD_KEY);

  const neighbourhood = (await editor.hoverIn("assist")).placement?.assistNeighbourhood;
  const reach = neighbourhood?.ldu ?? 0;
  expect(reach, `seed ${pair.seed}: assist reaches at least one stud`).toBeGreaterThanOrEqual(STUD);
  const inside = [
    [0, -1],
    [0, 1],
    [1, 0],
    [-1, 0],
    [1, -1],
  ].filter(([along = 0, across = 0]) => STUD * Math.hypot(along, across) <= reach);
  for (const [along = 0, across = 0] of inside) {
    await editor.hoverPlacementAt(partner, seam.cursorAt(along, across));
    const hover = await editor.hoverIn("assist");
    const label = `seed ${pair.seed}: assist ${across} across, ${along} along`;
    const dx = seam.flush.x - hover.x;
    const dz = seam.flush.z - hover.z;
    expect(hover.placement?.accepted, `${label} is accepted`).toBe(true);
    expect(hover.placement?.pose, `${label} snaps flush`).toEqual(seam.flush);
    expect(
      [
        hover.placement?.magnet.dxLdu,
        hover.placement?.magnet.dzLdu,
        hover.placement?.magnet.dyPlates,
      ],
      `${label} is magnetised by exactly the offset`,
    ).toEqual([dx, dz, 0]);
    expect(
      sameDistance(hover.placement?.magnet.distanceLdu ?? Number.NaN, Math.sqrt(dx * dx + dz * dz)),
      `${label}: the magnet distance is the offset's length`,
    ).toBe(true);
    expect(
      hover.placement ? pinHoleJoints(hover.placement.mates) : 0,
      `${label}: every pin engages a hole`,
    ).toBe(pair.pins);
  }

  const beyondAcross = (neighbourhood?.cells ?? 0) + 1;
  await editor.hoverPlacementAt(partner, seam.cursorAt(0, beyondAcross));
  const assistBeyond = await editor.hoverIn("assist");
  await page.keyboard.press(TOGGLE_KEY);
  const preciseBeyond = await editor.hoverIn("precise");
  await page.keyboard.press(TOGGLE_KEY);
  await editor.hoverIn("assist");
  expect(
    [assistBeyond.x, assistBeyond.z, placementVerdict(assistBeyond.placement)],
    `seed ${pair.seed}: ${beyondAcross} studs in, beyond the neighbourhood, assist gives exactly the precise result`,
  ).toEqual([preciseBeyond.x, preciseBeyond.z, placementVerdict(preciseBeyond.placement)]);
  expect(
    hit(preciseBeyond),
    `seed ${pair.seed}: ${beyondAcross} studs in is refused with a real hit (${JSON.stringify(preciseBeyond.placement?.hit)})`,
  ).toBe(true);

  const shortPoint = await editor.hoverPlacementAt(partner, short);
  await editor.hoverIn("assist");
  await page.mouse.click(shortPoint.sx, shortPoint.sy);
  await expect.poll(() => editor.poses()).toContainEqual({ item: partner, ...seam.flush });
  await editor.undo();

  await page.keyboard.press(TOGGLE_KEY);
  await editor.hoverPlacementAt(partner, seam.flush);
  const preciseFlush = await editor.hoverIn("precise");
  expect(preciseFlush.placement?.accepted, `seed ${pair.seed}: precise flush is accepted`).toBe(
    true,
  );
  expect(atCursor(preciseFlush), `seed ${pair.seed}: precise flush stays at the cursor`).toBe(true);
  expect(
    preciseFlush.placement ? pinHoleJoints(preciseFlush.placement.mates) : 0,
    `seed ${pair.seed}: precise flush mates every pin`,
  ).toBe(pair.pins);

  const preciseShortPoint = await editor.hoverPlacementAt(partner, short);
  const preciseShort = await editor.hoverIn("precise");
  expect(
    preciseShort.placement?.accepted,
    `seed ${pair.seed}: precise one stud short is accepted`,
  ).toBe(true);
  expect(atCursor(preciseShort), `seed ${pair.seed}: it stays at the cursor, leaving a gap`).toBe(
    true,
  );
  expect(preciseShort.placement?.mates, `seed ${pair.seed}: with no mates`).toEqual([]);
  await page.mouse.click(preciseShortPoint.sx, preciseShortPoint.sy);
  await expect
    .poll(() => editor.poses())
    .toContainEqual({ item: partner, x: preciseShort.x, z: preciseShort.z, yPlates: 0, rot: 0 });
  await editor.undo();

  const preciseInPoint = await editor.hoverPlacementAt(partner, seam.cursorAt(0, 1));
  const preciseIn = await editor.hoverIn("precise");
  expect(atCursor(preciseIn), `seed ${pair.seed}: precise one stud in stays at the cursor`).toBe(
    true,
  );
  expect(
    hit(preciseIn),
    `seed ${pair.seed}: precise one stud in is refused with a real hit (${JSON.stringify(preciseIn.placement?.hit)})`,
  ).toBe(true);
  await page.mouse.click(preciseInPoint.sx, preciseInPoint.sy);
  expect(await editor.poses()).toEqual([placed]);
  await page.keyboard.press(TOGGLE_KEY);
  await expectMode(editor, "assist", "assist", false);
});

test("a generated pinned module held against solid bricks is refused in both modes where its pins hit, naming the brick and cell, and never moves to a free pose", async ({
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
  const seam = await seamBeside(editor, placed, subject, heldOffset, pair.alongEdge);
  const verdicts = new Map<PlacementMode, ReadonlyArray<string>>();

  for (const mode of ["assist", "precise"] as const) {
    const flushPoint = await editor.hoverPlacementAt(subject, seam.flush);
    if ((await editor.placementModes()).mode !== mode) await page.keyboard.press(TOGGLE_KEY);
    const flush = await editor.hoverIn(mode);
    expect(atCursor(flush), `seed ${pair.seed}: ${mode} flush stays at the cursor`).toBe(true);
    expect(
      realHit(
        flush,
        solid,
        pair.solidPartner.assembly,
        pinsOf(pair.subject.assembly),
        placed,
        seam,
      ),
      `seed ${pair.seed}: ${mode} flush is refused, naming a part of the solid module and the pin cell it hits (${JSON.stringify(flush.placement?.hit)})`,
    ).toBe(true);
    expect(
      flush.placement ? pinHoleJoints(flush.placement.mates) : -1,
      `seed ${pair.seed}: ${mode}: no pin finds a hole`,
    ).toBe(0);
    await page.mouse.click(flushPoint.sx, flushPoint.sy);
    expect(await editor.poses()).toEqual([placed]);

    await editor.hoverPlacementAt(subject, seam.cursorAt(0, -1));
    const clear = await editor.hoverIn(mode);
    expect(clear.placement?.accepted, `seed ${pair.seed}: ${mode} one stud clear is accepted`).toBe(
      true,
    );
    expect(atCursor(clear), `seed ${pair.seed}: ${mode} one stud clear stays at the cursor`).toBe(
      true,
    );
    expect(
      clear.placement?.mates,
      `seed ${pair.seed}: ${mode} one stud clear has no mates`,
    ).toEqual([]);
    verdicts.set(
      mode,
      [flush, clear].map((hover) => `${hover.x},${hover.z} ${placementVerdict(hover.placement)}`),
    );
  }
  expect(
    verdicts.get("assist"),
    `seed ${pair.seed}: assist gives exactly the precise result`,
  ).toEqual(verdicts.get("precise"));
  await page.keyboard.press(TOGGLE_KEY);
  await expectMode(editor, "assist", "assist", false);
});

async function reachAfterZooming(
  editor: EditorPage,
  partner: string,
  seam: Seam,
  wheelStep: number,
  reached: (reach: number) => boolean,
): Promise<number> {
  const readReach = async (): Promise<number> => {
    await editor.hoverPlacementAt(partner, seam.cursorAt(0, -1));
    return (await editor.hoverIn("assist")).placement?.assistNeighbourhood.ldu ?? Number.NaN;
  };
  let reach = await readReach();
  for (let step = 0; step < ZOOM_STEPS && !reached(reach); step++) {
    await editor.escape();
    await editor.zoomAt(seam.flush, wheelStep);
    reach = await readReach();
  }
  return reach;
}

test("the assist neighbourhood follows the zoom, reaching exactly its floor up close and its cap in overview, and assist snaps exactly within it", async ({
  page,
}) => {
  const pair = await freshPair();
  const { editor, items } = await importModels(page, [pair.subject, pair.partner]);
  const [subject = "", partner = ""] = items;
  const placed = await placedAtOrigin(editor, subject);
  const seam = await seamBeside(editor, placed, partner, pair.partnerOffset, pair.alongEdge);
  await editor.goTo(seam.flush);
  const views = [
    {
      view: "close",
      wheelStep: ZOOM_STEP_IN,
      settles: ASSIST_FLOOR_LDU,
      reached: (reach: number) => reach <= ASSIST_FLOOR_LDU,
    },
    {
      view: "overview",
      wheelStep: ZOOM_STEP_OUT,
      settles: ASSIST_CAP_LDU,
      reached: (reach: number) => reach >= ASSIST_CAP_LDU,
    },
  ] as const;
  for (const { view, wheelStep, settles, reached } of views) {
    const reach = await reachAfterZooming(editor, partner, seam, wheelStep, reached);
    expect(
      reach,
      `seed ${pair.seed}: at ${view} zoom the neighbourhood reaches exactly ${settles} LDU`,
    ).toBe(settles);
    for (let studs = 1; studs * STUD <= reach + STUD; studs++) {
      await editor.hoverPlacementAt(partner, seam.cursorAt(0, -studs));
      const hover = await editor.hoverIn("assist");
      const label = `seed ${pair.seed}: ${view} zoom, ${studs} studs short`;
      if (studs * STUD <= reach) {
        expect(hover.placement?.pose, `${label} snaps flush`).toEqual(seam.flush);
        expect(
          hover.placement ? pinHoleJoints(hover.placement.mates) : 0,
          `${label}: every pin engages a hole`,
        ).toBe(pair.pins);
      } else {
        expect(hover.placement?.accepted, `${label} is accepted where it is`).toBe(true);
        expect(atCursor(hover), `${label} stays at the cursor, beyond the neighbourhood`).toBe(
          true,
        );
        expect(hover.placement?.mates, `${label} has no mates`).toEqual([]);
      }
    }
  }
});

interface RacedClick {
  readonly atClick: DumpedPlacementHover | null;
  readonly committed: ReadonlyArray<Pose>;
  readonly settled: DumpedPlacementHover;
}

async function placeRowPrecisely(
  page: Page,
  editor: EditorPage,
  row: ReadonlyArray<Pose>,
): Promise<void> {
  const [first] = row;
  if (!first) throw new Error("a row needs at least one modular");
  await editor.choose(first.item);
  if ((await editor.placementModes()).mode !== "precise") await page.keyboard.press(TOGGLE_KEY);
  await expect.poll(async () => (await editor.placementModes()).mode).toBe("precise");
  for (const pose of row) await editor.placeAt(pose.item, { x: pose.x, z: pose.z });
  expect(await editor.poses(), "the row stands where it was placed").toEqual(
    row.toSorted(byPosition),
  );
  await page.keyboard.press(TOGGLE_KEY);
  await expect.poll(async () => (await editor.placementModes()).mode).toBe("assist");
}

async function clickBeforeSettle(
  page: Page,
  editor: EditorPage,
  row: ReadonlyArray<Pose>,
  held: string,
  away: ScreenPoint,
  aim: ScreenPoint,
): Promise<RacedClick> {
  const holdAway = async (): Promise<void> => {
    await editor.escape();
    await editor.choose(held);
    await page.mouse.move(away.sx, away.sy);
    await editor.hoverIn("assist");
  };
  const added = async (): Promise<ReadonlyArray<Pose>> =>
    (await editor.poses()).filter(
      (pose) => !row.some((placed) => JSON.stringify(placed) === JSON.stringify(pose)),
    );
  await holdAway();
  await page.mouse.move(aim.sx, aim.sy);
  const atClick = await editor.hoverPlacement();
  await page.mouse.click(aim.sx, aim.sy);
  const committed = await added();
  if (committed.length > 0) await editor.undo();
  expect(await added(), "undo leaves only the row").toEqual([]);
  await holdAway();
  await page.mouse.move(aim.sx, aim.sy);
  const settled = (await editor.hoverIn("assist")).placement;
  if (!settled) throw new Error("no settled placement hover at the aim");
  return { atClick, committed, settled };
}

function annotateRace({ atClick, settled }: RacedClick): void {
  const raced = atClick !== null && !atClick.settled;
  const provisional = atClick
    ? `${atClick.accepted ? "accepted" : "refused"} at ${JSON.stringify(atClick.pose)}`
    : "no hover";
  test.info().annotations.push({
    type: "click before settle",
    description: raced
      ? `raced: clicked while settled was false, provisionally ${provisional}; settled ${settled.accepted ? "accepted" : "refused"} at ${JSON.stringify(settled.pose)}`
      : `didn't race: the search had settled before the click (${provisional})`,
  });
}

test("a held modular jumped onto a row of modulars and clicked before assist settles commits the pose the search settles on", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.zoom(500);
  const { wide } = await editor.itemStuds(BASEPLATE);
  const side = wide * STUD;
  const away = await editor.screenOf({ x: 0, z: side });
  const onRow = await editor.screenOf({ x: 0, z: 0 });
  const row: ReadonlyArray<Pose> = [MARKET_STREET, PET_SHOP, GROCER].map((item, index) => ({
    item,
    x: (index - 1) * side,
    z: 0,
    yPlates: 0,
    rot: 0,
  }));
  await placeRowPrecisely(page, editor, row);
  const raced = await clickBeforeSettle(page, editor, row, MARKET_STREET, away, onRow);
  annotateRace(raced);
  const { atClick, committed, settled } = raced;
  expect(
    committed,
    `the click commits the settled ${settled.accepted ? `pose ${JSON.stringify(settled.pose)}` : "refusal"}, never a provisional pose (at the click: ${JSON.stringify(atClick)})`,
  ).toEqual(settled.accepted ? [{ item: MARKET_STREET, ...settled.pose }] : []);
});

test("a held modular clicked within reach of a flush join before assist settles commits the join, never the refusal at the cursor", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.zoom(500);
  const { wide } = await editor.itemStuds(BASEPLATE);
  const side = wide * STUD;
  const flushJoin = { x: -side, z: 0 };
  const aimAt = { x: flushJoin.x + ASSIST_CAP_LDU, z: flushJoin.z };
  const away = await editor.screenOf({ x: 0, z: side });
  const aim = await editor.screenOf(aimAt);
  const row: ReadonlyArray<Pose> = [
    { item: MARKET_STREET, x: 0, z: 0, yPlates: 0, rot: 0 },
    { item: PET_SHOP, x: side, z: 0, yPlates: 0, rot: 0 },
    { item: GROCER, x: 2 * side + RELOCATING_GAP_STUDS * STUD, z: 0, yPlates: 0, rot: 0 },
  ];
  await placeRowPrecisely(page, editor, row);
  const raced = await clickBeforeSettle(page, editor, row, MARKET_STREET, away, aim);
  annotateRace(raced);
  const { atClick, committed, settled } = raced;
  expect(settled.assistNeighbourhood.ldu, "R is at its 60 LDU cap, as at the default zoom").toBe(
    ASSIST_CAP_LDU,
  );
  expect(
    {
      accepted: settled.accepted,
      magnetised: settled.magnetised,
      pose: settled.pose,
      joints: pinHoleJoints(settled.mates),
    },
    "the settled hover joins flush on the placed modular's west face with its pins in the holes",
  ).toEqual({
    accepted: true,
    magnetised: true,
    pose: { x: flushJoin.x, z: flushJoin.z, yPlates: 0, rot: 0 },
    joints: WEST_FACE_PIN_JOINTS,
  });
  expect(
    committed,
    `the click commits the flush join, never a refusal or the cursor pose (at the click: ${JSON.stringify(atClick)})`,
  ).toEqual([{ item: MARKET_STREET, x: flushJoin.x, z: flushJoin.z, yPlates: 0, rot: 0 }]);
});
