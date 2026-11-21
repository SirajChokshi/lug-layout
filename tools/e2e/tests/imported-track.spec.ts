import { expect, test, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import {
  EditorPage,
  STUD,
  nearestLattice,
  routeMiddle,
  shiftedPosition,
  type PlanRow,
} from "./editor-page.ts";

const SCENES = new URL("../../../docs/verified-facts/scenes/", import.meta.url);
const GEOMETRY = new URL("../../../docs/verified-facts/geometry.json", import.meta.url);
const ZETA16_STEP_RADIANS = Math.PI / 8;
const LDRAW_DECIMALS = 6;
const EDITOR_DECIMALS = 3;
const FAR_LDU = 20_480;
const OFF_FIELD_RADIANS = (0.1 * Math.PI) / 180;
const TYPE_ONE_FIELDS = 15;
const FULL_THROTTLE_PRESSES = 10;
const TRAIN_WITHOUT_TRACK = "omr:10014-1";
const LAP_DEADLINE_MS = 90_000;
const SAMPLE_MS = 150;
const STRAIGHT_FILE = "74746.dat";
const RUN_OFFSET_LDU = -960;
const RUN_HALF_SPAN_LDU = 160;
const EAST = 0;
const DRAWN_RUN_LDU = 640;
const HALF_TURN_CURVES = 8;
const PLAIN_MODULE = "generated:mils-plain";
const RAISED_OFFSET_LDU = 1600;
const WEST = 8;
const TABLE_GRID_LDU = 8 * STUD;
const LOOP_SPAN_LDU = 2 * 40 * STUD + TABLE_GRID_LDU;
const DRAWN_PAST_TABLE_LDU = 64 * STUD;
const PLASTIC_OVAL_OFFSET_LDU = 640;
const PLASTIC_FILES: ReadonlySet<string> = new Set(["53401.dat", "53400.dat"]);
const KINKED_RUN_FREE_ENDS = 2;
const PLASTIC_OVAL_STRAIGHT_RUNS = 2;

interface Reference {
  readonly color: string;
  readonly position: readonly [number, number, number];
  readonly matrix: ReadonlyArray<number>;
  readonly file: string;
}

interface Geometry {
  readonly rails: ReadonlyArray<{
    readonly part: string;
    readonly railTopY: string;
    readonly railTopAboveUndersideLdu: string;
  }>;
}

interface Arrangement {
  readonly scene: string;
  readonly turns: number;
  readonly offset: readonly [number, number];
}

async function sceneReferences(scene: string): Promise<ReadonlyArray<Reference>> {
  const text = await readFile(new URL(`${scene}.ldr`, SCENES), "utf8");
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u))
    .filter((fields) => fields[0] === "1" && fields.length === TYPE_ONE_FIELDS)
    .map((fields) => ({
      color: fields[1] ?? "16",
      position: [Number(fields[2]), Number(fields[3]), Number(fields[4])] as const,
      matrix: fields.slice(5, 14).map(Number),
      file: fields[14] ?? "",
    }));
}

function rotatedMatrix(m: ReadonlyArray<number>, radians: number): ReadonlyArray<number> {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const top = m.slice(0, 3);
  const bottom = m.slice(6, 9);
  return [
    ...top.map((value, c) => cos * value + sin * (bottom[c] ?? 0)),
    ...m.slice(3, 6),
    ...bottom.map((value, c) => -sin * (top[c] ?? 0) + cos * value),
  ];
}

function turnedAboutY(
  reference: Reference,
  radians: number,
  offset: readonly [number, number],
): Reference {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const [x, y, z] = reference.position;
  return {
    ...reference,
    position: [cos * x + sin * z + offset[0], y, -sin * x + cos * z + offset[1]],
    matrix: rotatedMatrix(reference.matrix, radians),
  };
}

function turnedInPlace(reference: Reference, radians: number): Reference {
  return { ...reference, matrix: rotatedMatrix(reference.matrix, radians) };
}

function decimal(value: number, decimals: number): string {
  const text = value.toFixed(decimals).replace(/\.?0+$/u, "");
  return text === "-0" ? "0" : text;
}

function ldrawLine(reference: Reference, decimals: number): string {
  return [
    "1",
    reference.color,
    ...reference.position.map((value) => decimal(value, decimals)),
    ...reference.matrix.map((value) => decimal(value, decimals)),
    reference.file,
  ].join(" ");
}

async function layout(
  name: string,
  arrangements: ReadonlyArray<Arrangement>,
  adjust: (references: Reference[]) => void = () => {},
  decimals: number = LDRAW_DECIMALS,
): Promise<{ readonly text: string; readonly pieces: number }> {
  const references: Reference[] = [];
  for (const { scene, turns, offset } of arrangements) {
    for (const reference of await sceneReferences(scene)) {
      references.push(turnedAboutY(reference, turns * ZETA16_STEP_RADIANS, offset));
    }
  }
  adjust(references);
  const text = [
    `0 ${name}`,
    `0 Name: ${name}.ldr`,
    "0 Author: lug-layout e2e (generated at test time from docs/verified-facts/scenes)",
    "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
    "1 2 0 0 0 1 0 0 0 1 0 0 0 1 3811.dat",
    ...references.map((reference) => ldrawLine(reference, decimals)),
    "",
  ].join("\n");
  return { text, pieces: references.length };
}

function sweptTurns(path: ReadonlyArray<readonly [number, number]>): number {
  if (path.length < 2) return 0;
  const xs = path.map(([x]) => x);
  const zs = path.map(([, z]) => z);
  const centreX = (Math.min(...xs) + Math.max(...xs)) / 2;
  const centreZ = (Math.min(...zs) + Math.max(...zs)) / 2;
  let swept = 0;
  for (let i = 1; i < path.length; i++) {
    const [x0, z0] = path[i - 1] ?? [0, 0];
    const [x1, z1] = path[i] ?? [0, 0];
    const step = Math.atan2(z1 - centreZ, x1 - centreX) - Math.atan2(z0 - centreZ, x0 - centreX);
    swept += Math.atan2(Math.sin(step), Math.cos(step));
  }
  return Math.abs(swept) / (2 * Math.PI);
}

async function importAndPlace(page: Page, file: string): Promise<EditorPage> {
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary();
  const imported = await editor.importModel(file);
  expect(imported.status, imported.text).toBe("placeable");
  await editor.zoom(400);
  await editor.placeAt(imported.item, { x: 0, z: 0 });
  await editor.escape();
  await editor.press("t");
  return editor;
}

test("the verified R40 circle imported as a file identifies all 16 curves and closes", async ({
  page,
}) => {
  const { text, pieces } = await layout("r40-circle", [
    { scene: "r40-circle-9v", turns: 0, offset: [0, 0] },
  ]);
  const file = test.info().outputPath("r40-circle.ldr");
  await writeFile(file, text);

  const editor = await importAndPlace(page, file);

  expect(pieces).toBe(16);
  expect(await editor.modelTrack()).toEqual({ pieces, runFrame: 0, offField: 0, unanchored: 0 });
  expect(await editor.trackEnds()).toEqual([]);
});

test("a layout of circles, a figure-eight and switches turned in 22.5° steps far from the origin joins every end", async ({
  page,
}) => {
  const { text, pieces } = await layout("turned-layouts", [
    { scene: "r40-circle-9v", turns: 3, offset: [FAR_LDU, 0] },
    { scene: "figure-eight", turns: 1, offset: [-FAR_LDU, 0] },
    { scene: "passing-loop", turns: 5, offset: [2 * FAR_LDU, 0] },
    { scene: "passing-loop", turns: 10, offset: [-2 * FAR_LDU, 0] },
  ]);
  const file = test.info().outputPath("turned-layouts.ldr");
  await writeFile(file, text);

  const editor = await importAndPlace(page, file);

  expect(await editor.modelTrack()).toEqual({ pieces, runFrame: 0, offField: 0, unanchored: 0 });
  expect(await editor.trackEnds()).toEqual([]);
});

test("the layouts turned in quarter turns and written with three decimals, as LDraw editors print them, identify every piece and join every end", async ({
  page,
}) => {
  const { text, pieces } = await layout(
    "quarter-turned-three-decimals",
    [
      { scene: "r40-circle-9v", turns: 4, offset: [FAR_LDU, 0] },
      { scene: "figure-eight", turns: 8, offset: [-FAR_LDU, 0] },
      { scene: "passing-loop", turns: 12, offset: [2 * FAR_LDU, 0] },
      { scene: "passing-loop", turns: 0, offset: [-2 * FAR_LDU, 0] },
    ],
    () => {},
    EDITOR_DECIMALS,
  );
  const file = test.info().outputPath("quarter-turned-three-decimals.ldr");
  await writeFile(file, text);

  const editor = await importAndPlace(page, file);

  expect(await editor.modelTrack()).toEqual({ pieces, runFrame: 0, offField: 0, unanchored: 0 });
  expect(await editor.trackEnds()).toEqual([]);
});

test("layouts turned off the quarter turns and written with three decimals are identified in run frames, joined only inside them", async ({
  page,
}) => {
  const { text, pieces } = await layout(
    "turned-three-decimals",
    [
      { scene: "r40-circle-9v", turns: 3, offset: [FAR_LDU, 0] },
      { scene: "figure-eight", turns: 1, offset: [-FAR_LDU, 0] },
      { scene: "passing-loop", turns: 5, offset: [2 * FAR_LDU, 0] },
      { scene: "passing-loop", turns: 10, offset: [-2 * FAR_LDU, 0] },
    ],
    () => {},
    EDITOR_DECIMALS,
  );
  const file = test.info().outputPath("turned-three-decimals.ldr");
  await writeFile(file, text);

  const editor = await importAndPlace(page, file);

  expect(await editor.modelTrack()).toEqual({
    pieces: 0,
    runFrame: pieces,
    offField: 0,
    unanchored: 0,
  });
  expect(await editor.trackEnds()).toEqual([]);
});

test("a train runs a full lap on an imported loop turned 22.5° and written with three decimals", async ({
  page,
}) => {
  const { text, pieces } = await layout(
    "turned-loop-three-decimals",
    [{ scene: "r40-circle-9v", turns: 3, offset: [FAR_LDU, 0] }],
    () => {},
    EDITOR_DECIMALS,
  );
  const file = test.info().outputPath("turned-loop-three-decimals.ldr");
  await writeFile(file, text);
  const editor = await importAndPlace(page, file);
  expect(await editor.modelTrack()).toEqual({
    pieces: 0,
    runFrame: pieces,
    offField: 0,
    unanchored: 0,
  });

  const [route] = await editor.trackRoutes();
  if (!route) throw new Error("the imported loop has no route");
  await editor.escape();
  await editor.goTo(routeMiddle(route));
  await editor.placeAt(TRAIN_WITHOUT_TRACK, routeMiddle(route));
  await editor.escape();
  expect(await editor.trainsOnRails()).toBe(1);
  await editor.press("t");
  expect(await editor.modelTrack()).toEqual({
    pieces: 0,
    runFrame: pieces,
    offField: 0,
    unanchored: 0,
  });
  await editor.escape();
  await editor.startPlay();
  for (let press = 0; press < FULL_THROTTLE_PRESSES; press++) await editor.press("]");

  const path: Array<readonly [number, number]> = [];
  const deadline = Date.now() + LAP_DEADLINE_MS;
  while (sweptTurns(path) < 1 && Date.now() < deadline) {
    const state = await editor.playState();
    expect(state).toMatchObject({ status: "running", bogiesOff: 0, derailSpeed: 0 });
    path.push([state.xLdu, state.zLdu]);
    await page.waitForTimeout(SAMPLE_MS);
  }
  expect(sweptTurns(path)).toBeGreaterThanOrEqual(1);
});

async function undersideBelowOriginLdu(part: string): Promise<number> {
  const geometry: Geometry = JSON.parse(await readFile(GEOMETRY, "utf8"));
  const rail = geometry.rails.find((entry) => entry.part === part);
  if (!rail) throw new Error(`geometry.json measures no rail for ${part}`);
  return Number(rail.railTopY) + Number(rail.railTopAboveUndersideLdu);
}

async function nineVoltRun(
  liftLdu = 0,
): Promise<{ readonly file: string; readonly pieces: number }> {
  const { text, pieces } = await layout(
    "nine-volt-run",
    [{ scene: "passing-loop", turns: 0, offset: [RUN_OFFSET_LDU, 0] }],
    (references) => {
      const run = references
        .filter(
          ({ file, position: [x, , z] }) =>
            file === STRAIGHT_FILE && z === 0 && Math.abs(x) <= RUN_HALF_SPAN_LDU,
        )
        .map((reference): Reference => {
          const [x, y, z] = reference.position;
          return { ...reference, position: [x, y - liftLdu, z] };
        });
      references.splice(0, references.length, ...run);
    },
  );
  const file = test.info().outputPath("nine-volt-run.ldr");
  await writeFile(file, text);
  return { file, pieces };
}

test("drawn track joined to an imported model's own 9V run is lifted by undo and joined again by redo", async ({
  page,
}) => {
  const { file, pieces } = await nineVoltRun();
  const editor = await importAndPlace(page, file);
  expect(pieces).toBe(2);
  expect(await editor.modelTrack()).toEqual({ pieces, runFrame: 0, offField: 0, unanchored: 0 });
  const placed = await editor.poses();
  const modelEnds = await editor.trackEnds();
  const east = modelEnds.find((end) => end.heading === EAST);
  if (!east)
    throw new Error(`the model's run has no end facing east: ${JSON.stringify(modelEnds)}`);

  const from = nearestLattice(east);
  const run = await editor.dragTrack(from, { x: from.x + DRAWN_RUN_LDU, z: from.z });
  const laid = await editor.laidTrack();
  const joinedEnds = await editor.trackEnds();
  expect(run).toEqual({ lastCommit: "laid", pieces: 2, openEnds: 2, joins: 3 });
  expect(laid).toHaveLength(2);
  expect(joinedEnds).not.toContainEqual(east);

  await editor.undo();
  expect(await editor.laidTrack()).toEqual([]);
  expect(await editor.trackEnds()).toEqual(modelEnds);
  expect(await editor.poses()).toEqual(placed);

  await editor.redo();
  expect(await editor.laidTrack()).toEqual(laid);
  expect(await editor.trackEnds()).toEqual(joinedEnds);
  expect(await editor.trackCounts()).toEqual(run);
});

test("an imported model's open end is extended from the keyboard into a loop that closes on its other end, and undone one step at a time", async ({
  page,
}) => {
  const { file, pieces } = await nineVoltRun(
    await undersideBelowOriginLdu(STRAIGHT_FILE.replace(".dat", "")),
  );
  const editor = await importAndPlace(page, file);
  const modelEnds = await editor.trackEnds();
  const east = modelEnds.find((end) => end.heading === EAST);
  if (!east)
    throw new Error(`the model's run has no end facing east: ${JSON.stringify(modelEnds)}`);
  await editor.hoverAt(await editor.screenOf(nearestLattice(east)));
  const offered = await editor.trackChoice();
  const keys = [
    ...Array<string>(HALF_TURN_CURVES).fill("a"),
    ...Array<string>(pieces).fill("w"),
    ...Array<string>(HALF_TURN_CURVES / 2).fill("a"),
  ];

  const counts = [];
  for (const key of keys) {
    await editor.press(key);
    counts.push(await editor.trackCounts());
  }
  const suggested = await editor.trackChoice();
  await editor.press("Enter");
  const closed = await editor.trackCounts();

  expect(offered).toEqual({ kind: "straight", pieces: 1, joins: false });
  expect(counts).toEqual(
    keys.map((_, i) => ({ lastCommit: "laid", pieces: i + 1, openEnds: 2, joins: pieces + i })),
  );
  expect(suggested).toEqual({ kind: "join", pieces: HALF_TURN_CURVES / 2, joins: true });
  const loop = pieces + keys.length + HALF_TURN_CURVES / 2;
  expect(closed).toEqual({
    lastCommit: "joined",
    pieces: loop - pieces,
    openEnds: 0,
    joins: loop,
  });
  await editor.waitForFarTierAndMeshesSettled();
  await page.screenshot({ path: test.info().outputPath("extended-imported-run.png") });

  await editor.undo();
  expect(await editor.laidTrack()).toHaveLength(keys.length);
  for (let left = keys.length - 1; left >= 0; left--) {
    await editor.undo();
    expect(await editor.laidTrack()).toHaveLength(left);
  }
  expect(await editor.trackEnds()).toEqual(modelEnds);
});

test("a curve turned 0.1° off the field is reported and nothing joins it", async ({ page }) => {
  const { text, pieces } = await layout(
    "off-field-curve",
    [{ scene: "r40-circle-9v", turns: 2, offset: [FAR_LDU, 0] }],
    (references) => {
      const first = references[0];
      if (first) references[0] = turnedInPlace(first, OFF_FIELD_RADIANS);
    },
  );
  const file = test.info().outputPath("off-field-curve.ldr");
  await writeFile(file, text);

  const editor = await importAndPlace(page, file);

  expect(await editor.modelTrack()).toEqual({
    pieces: pieces - 1,
    runFrame: 0,
    offField: 1,
    unanchored: 0,
  });
  expect(await editor.trackEnds()).toHaveLength(2);
});

test("an imported model whose own 9V run is joined to drawn track won't nudge off that join alone, and moves with the drawn run as one undo step that keeps every join", async ({
  page,
}) => {
  const { text } = await layout(
    "nine-volt-run",
    [{ scene: "passing-loop", turns: 0, offset: [RUN_OFFSET_LDU, 0] }],
    (references) => {
      const run = references.filter(
        ({ file, position: [x, , z] }) =>
          file === STRAIGHT_FILE && z === 0 && Math.abs(x) <= RUN_HALF_SPAN_LDU,
      );
      references.splice(0, references.length, ...run);
    },
  );
  const file = test.info().outputPath("nine-volt-run.ldr");
  await writeFile(file, text);
  const editor = await importAndPlace(page, file);
  const model = (await editor.poses())[0];
  const east = (await editor.trackEnds()).find((end) => end.heading === EAST);
  if (!model || !east) throw new Error("the imported run has no end facing east");
  const from = nearestLattice(east);
  const run = await editor.dragTrack(from, { x: from.x + DRAWN_RUN_LDU, z: from.z });
  expect(run).toMatchObject({ pieces: 2, joins: 3 });
  await editor.escape();
  const raised = { x: model.x, z: model.z + RAISED_OFFSET_LDU };
  await editor.placeAt(PLAIN_MODULE, raised);
  await editor.escape();
  const laid = { poses: await editor.poses(), track: await editor.laidTrack() };

  expect(await editor.select({ x: model.x, z: model.z })).toBe(model.item);
  const refusedBefore = await editor.counter("refused");
  await editor.press("ArrowUp");
  await expect(page.locator(".tool-hud")).toContainText("pull that join apart");
  expect(await editor.counter("refused")).toBe(refusedBefore + 1);
  expect({ poses: await editor.poses(), track: await editor.laidTrack() }).toEqual(laid);

  await editor.shiftClickAt({ x: from.x + DRAWN_RUN_LDU / 4, z: from.z });
  await editor.shiftClickAt({ x: from.x + (DRAWN_RUN_LDU * 3) / 4, z: from.z });
  expect(await editor.selectionCount()).toBe(3);
  await editor.press("ArrowUp");
  const moved = { poses: await editor.poses(), track: await editor.laidTrack() };
  const movedModel = moved.poses.find((pose) => pose.item === model.item);
  if (!movedModel) throw new Error("the nudge lost the imported model");
  const dx = movedModel.x - model.x;
  const dz = movedModel.z - model.z;
  expect(Math.abs(dx) + Math.abs(dz)).toBe(STUD);
  expect(movedModel).toEqual({ ...model, x: model.x + dx, z: model.z + dz });
  expect(moved).toEqual({
    poses: laid.poses.map((pose) => (pose.item === model.item ? movedModel : pose)),
    track: laid.track.map((piece) => ({
      ...piece,
      position: shiftedPosition(piece.position, dx, dz),
    })),
  });
  expect(await editor.trackCounts()).toMatchObject({ pieces: 2, joins: 3, openEnds: 2 });

  await editor.undo();
  expect({ poses: await editor.poses(), track: await editor.laidTrack() }).toEqual(laid);
  await editor.redo();
  expect({ poses: await editor.poses(), track: await editor.laidTrack() }).toEqual(moved);
  expect(await editor.selectionCount()).toBe(3);

  await editor.dragFrom({ x: movedModel.x, z: movedModel.z }, { x: raised.x, z: raised.z + dz });
  await expect(page.locator(".tool-hud")).toContainText(
    "would hit Brick 2 x 2 in MILS Basic Terrain Module",
  );
  expect({ poses: await editor.poses(), track: await editor.laidTrack() }).toEqual(moved);
});

function gridDown(ldu: number): number {
  return Math.floor(ldu / TABLE_GRID_LDU) * TABLE_GRID_LDU;
}

function gridUp(ldu: number): number {
  return Math.ceil(ldu / TABLE_GRID_LDU) * TABLE_GRID_LDU;
}

function ruled(rows: ReadonlyArray<PlanRow>, rule: string): ReadonlyArray<string> {
  return rows.filter((row) => row.rule === rule).map((row) => row.message);
}

async function planShot(page: Page, name: string): Promise<void> {
  await page.locator(".plan-panel").screenshot({ path: test.info().outputPath(`${name}.png`) });
}

test("a plan lists an imported 9V run's open ends, clears them when the loop closes from the keyboard while the curves past the table edge stay listed, and undo and redo bring the open ends back and clear them again", async ({
  page,
}) => {
  const { file, pieces } = await nineVoltRun(
    await undersideBelowOriginLdu(STRAIGHT_FILE.replace(".dat", "")),
  );
  const editor = await importAndPlace(page, file);
  const ends = await editor.trackEnds();
  const east = ends.find((end) => end.heading === EAST);
  const west = ends.find((end) => end.heading === WEST);
  const [model] = await editor.footprints();
  if (!east || !west || !model) throw new Error(`the run has no ends: ${JSON.stringify(ends)}`);
  await editor.drawTable(
    {
      x: gridDown(Math.min(model.box.minX, west.xLdu - LOOP_SPAN_LDU / 2)),
      z: gridDown(Math.min(model.box.minZ, west.zLdu - LOOP_SPAN_LDU)),
    },
    {
      x: gridUp(model.box.maxX),
      z: gridUp(Math.max(model.box.maxZ, east.zLdu + LOOP_SPAN_LDU)),
    },
  );
  const placed = await editor.planRows();
  await planShot(page, "plan-open-ends-of-an-imported-run");
  await editor.press("t");
  await editor.hoverAt(await editor.screenOf(nearestLattice(east)));
  const keys = [
    ...Array<string>(HALF_TURN_CURVES).fill("a"),
    ...Array<string>(pieces).fill("w"),
    ...Array<string>(HALF_TURN_CURVES / 2).fill("a"),
  ];
  for (const key of keys) await editor.press(key);
  const open = await editor.planRows();
  await editor.press("Enter");
  const closed = await editor.planRows();
  await editor.waitForFarTierAndMeshesSettled();
  await planShot(page, "plan-loop-closed");
  await page.screenshot({ path: test.info().outputPath("loop-closed.png") });
  await editor.undo();
  const undone = await editor.planRows();
  await planShot(page, "plan-loop-undone");
  await editor.redo();
  const redone = await editor.planRows();

  const onTheRun = expect.stringMatching(
    /^Open track end at \(-?\d+ mm, -?\d+ mm\) on nine-volt-run\.ldr at -?\d+, -?\d+: nothing joins it\.$/u,
  );
  expect(placed.filter((row) => row.rule === "trackOpenEnd")).toEqual([
    { rule: "trackOpenEnd", severity: "error", message: onTheRun },
    { rule: "trackOpenEnd", severity: "error", message: onTheRun },
  ]);
  expect(ruled(open, "trackOpenEnd")).toEqual([
    expect.stringMatching(/ on Train Track 9V Curved #\d+: nothing joins it\.$/u),
    onTheRun,
  ]);
  expect(ruled(closed, "trackOpenEnd")).toEqual([]);
  expect(ruled(closed, "fit").length).toBeGreaterThan(0);
  for (const message of ruled(closed, "fit")) {
    expect(message).toMatch(/^Train Track 9V Curved #\d+ overhangs the tables/u);
  }
  expect(ruled(undone, "trackOpenEnd")).toEqual(ruled(open, "trackOpenEnd"));
  expect(redone).toEqual(closed);
});

async function kinkedRunBesidePlasticOval(): Promise<string> {
  const { text } = await layout(
    "kinked-run-and-plastic-oval",
    [
      { scene: "passing-loop", turns: 0, offset: [RUN_OFFSET_LDU, 0] },
      { scene: "plastic-oval", turns: 0, offset: [PLASTIC_OVAL_OFFSET_LDU, 0] },
    ],
    (references) => {
      const run = references.filter(
        ({ file, position: [x, , z] }) =>
          file === STRAIGHT_FILE && z === 0 && Math.abs(x) <= RUN_HALF_SPAN_LDU,
      );
      const eastmost = run.reduce((a, b) => (b.position[0] > a.position[0] ? b : a));
      const joint = [eastmost.position[0] - RUN_HALF_SPAN_LDU, eastmost.position[2]] as const;
      const turn = Math.PI / 2;
      const kink = turnedAboutY(eastmost, turn, [
        joint[0] - (Math.cos(turn) * joint[0] + Math.sin(turn) * joint[1]),
        joint[1] - (-Math.sin(turn) * joint[0] + Math.cos(turn) * joint[1]),
      ]);
      const plastic = references.filter(({ file }) => PLASTIC_FILES.has(file));
      references.splice(
        0,
        references.length,
        ...run.map((reference) => (reference === eastmost ? kink : reference)),
        ...plastic,
      );
    },
  );
  const file = test.info().outputPath("kinked-run-and-plastic-oval.ldr");
  await writeFile(file, text);
  return file;
}

test("a plan lists the kink in a user's 9V run as ends that don't join, warns that its plastic curves have unverified poses, and lists drawn track past the table edge", async ({
  page,
}) => {
  const editor = await importAndPlace(page, await kinkedRunBesidePlasticOval());
  const ends = await editor.trackEnds();
  const xs = ends.map((end) => end.xLdu);
  const westmost = ends.find((end) => end.heading === WEST && end.xLdu === Math.min(...xs));
  const [model] = await editor.footprints();
  if (!westmost || !model) throw new Error(`the run has no west end: ${JSON.stringify(ends)}`);
  await editor.drawTable(
    { x: gridDown(model.box.minX), z: gridDown(model.box.minZ) },
    { x: gridUp(model.box.maxX), z: gridUp(model.box.maxZ) },
  );
  const placed = await editor.planRows();
  await editor.press("t");
  const from = nearestLattice(westmost);
  await editor.dragTrack(from, { x: from.x - DRAWN_PAST_TABLE_LDU, z: from.z });
  const drawn = await editor.planRows();
  await planShot(page, "plan-kink-unverified-and-off-the-table");
  await page.screenshot({ path: test.info().outputPath("kink-plastic-oval-and-drawn-run.png") });

  expect(ruled(placed, "trackOpenEnd")).toHaveLength(
    KINKED_RUN_FREE_ENDS + 2 * PLASTIC_OVAL_STRAIGHT_RUNS,
  );
  expect(ruled(placed, "trackJoin")).toEqual([
    expect.stringMatching(
      /^Two track ends of kinked-run-and-plastic-oval\.ldr at -?\d+, -?\d+ meet at \(-?\d+ mm, -?\d+ mm\) but don't join: their headings are 90° off a straight join\.$/u,
    ),
  ]);
  expect(placed.filter((row) => row.severity === "warning")).toEqual([
    {
      rule: "trackUnverified",
      severity: "warning",
      message: expect.stringMatching(
        /^kinked-run-and-plastic-oval\.ldr at -?\d+, -?\d+ holds 16 × 53400 Train Track 6 Studs Wide Curved, whose connector poses are unverified, so the plan can't check their ends/u,
      ),
    },
  ]);
  expect(ruled(placed, "fit")).toEqual([]);
  expect(ruled(drawn, "fit").length).toBeGreaterThan(0);
  for (const message of ruled(drawn, "fit")) {
    expect(message).toMatch(/^Train Track 9V Straight #\d+ overhangs the tables/u);
  }
  expect(ruled(drawn, "trackJoin")).toEqual(ruled(placed, "trackJoin"));
  expect(ruled(drawn, "trackUnverified")).toEqual(ruled(placed, "trackUnverified"));
});
