import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import {
  STUD_LDU,
  ZETA16_STEP_RADIANS,
  attachPose16,
  composePose16,
  mmFromLdu,
  pose16,
  POSE16_IDENTITY,
  zeta16,
  zeta16Direction,
  zeta16ToStuds,
  type Pose16,
} from "@brr/math";
import { expect, test, type Page } from "@playwright/test";
import { EditorPage, type PlanRow } from "./editor-page.ts";

interface CatalogPiece {
  readonly id: string;
  readonly connectors: ReadonlyArray<{
    readonly coefficients: ReadonlyArray<string>;
    readonly heading: number;
  }>;
  readonly partFrame: {
    readonly xLdu: number;
    readonly zLdu: number;
    readonly headingHalfSteps: number;
  };
}

type Step = readonly [piece: string, entry: number, exit: number];

const CATALOG = new URL("../../../docs/verified-facts/track-catalog.json", import.meta.url);
const STRAIGHT = "ldraw:74746";
const CURVE = "ldraw:74747";
const SWITCH = "ldraw:75541-f2";
const ENTRY = 0;
const STRAIGHT_EXIT = 1;
const ALONG: Step = [STRAIGHT, 0, 1];
const TURNING_ON: Step = [CURVE, 0, 1];
const TURNING_BACK: Step = [CURVE, 1, 0];
const LDRAW_DECIMALS = 6;
const CHUNK_LDU = 640;
const PLACED_AT = { x: 0, z: 0 } as const;
const TABLE_FROM = { x: -2080, z: -1280 } as const;
const TABLE_TO = { x: 2080, z: 1280 } as const;
const SHORTS =
  "so each rail runs round into the other. That shorts two-rail powered track such as 9V or 12V.";

const pieces = (
  JSON.parse(readFileSync(CATALOG, "utf8")) as { readonly pieces: ReadonlyArray<CatalogPiece> }
).pieces;

function piece(id: string): CatalogPiece {
  const found = pieces.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`${id} isn't in the verified track catalog`);
  return found;
}

function connector(id: string, index: number): Pose16 {
  const end = piece(id).connectors[index];
  if (!end) throw new Error(`${id} has no connector ${index}`);
  return pose16(zeta16(end.coefficients.map((value) => BigInt(value))), end.heading);
}

function repeated(step: Step, count: number): ReadonlyArray<Step> {
  return Array.from({ length: count }, () => step);
}

const BALLOON_LOOP: ReadonlyArray<Step> = [
  ALONG,
  ...repeated(TURNING_BACK, 3),
  ...repeated(TURNING_ON, 7),
  ALONG,
  ...repeated(TURNING_ON, 5),
  ...repeated(ALONG, 5),
];

function decimal(value: number): string {
  const text = value.toFixed(LDRAW_DECIMALS).replace(/\.?0+$/u, "");
  return text === "-0" ? "0" : text;
}

function ldrawLine(id: string, placement: Pose16): string {
  const { partFrame } = piece(id);
  const at = zeta16ToStuds(placement.position);
  const facing = zeta16Direction(placement.heading);
  const x = at.x * STUD_LDU + facing.x * partFrame.xLdu - facing.z * partFrame.zLdu;
  const z = at.z * STUD_LDU + facing.z * partFrame.xLdu + facing.x * partFrame.zLdu;
  const turn = (placement.heading + partFrame.headingHalfSteps / 2) * ZETA16_STEP_RADIANS;
  const [cos, sin] = [Math.cos(turn), Math.sin(turn)];
  const matrix = [cos, 0, sin, 0, 1, 0, -sin, 0, cos];
  return ["1 16", ...[x, 0, -z, ...matrix].map(decimal), `${id.replace("ldraw:", "")}.dat`].join(
    " ",
  );
}

function laid(from: Pose16, steps: ReadonlyArray<Step>): ReadonlyArray<readonly [string, Pose16]> {
  let end = from;
  return steps.map(([id, entry, exit]) => {
    const placement = attachPose16(connector(id, entry), end);
    end = composePose16(placement, connector(id, exit));
    return [id, placement] as const;
  });
}

const TURNOUT = POSE16_IDENTITY;
const SWITCH_ENTRY = composePose16(TURNOUT, connector(SWITCH, ENTRY));
const STEM = laid(SWITCH_ENTRY, [ALONG]);

function balloonFile(name: string): string {
  const placed = [
    [SWITCH, TURNOUT] as const,
    ...STEM,
    ...laid(composePose16(TURNOUT, connector(SWITCH, STRAIGHT_EXIT)), BALLOON_LOOP),
  ];
  return [
    `0 ${name}`,
    `0 Name: ${name}`,
    "0 Author: lug-layout e2e (a user's file written at test time from official parts)",
    "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
    ...placed.map(([id, placement]) => ldrawLine(id, placement)),
    "",
  ].join("\n");
}

function stemEndToSwitchEntry(): { readonly x: number; readonly z: number } {
  const [stem] = STEM;
  if (!stem) throw new Error("no stem");
  const far = zeta16ToStuds(composePose16(stem[1], connector(STRAIGHT, 1)).position);
  const entry = zeta16ToStuds(SWITCH_ENTRY.position);
  return { x: (entry.x - far.x) * STUD_LDU, z: (entry.z - far.z) * STUD_LDU };
}

function planMm(ldu: number, originChunk: number): number {
  return Math.round(mmFromLdu(ldu - originChunk * CHUNK_LDU));
}

function ruled(rows: ReadonlyArray<PlanRow>, rule: string): ReadonlyArray<PlanRow> {
  return rows.filter((row) => row.rule === rule);
}

async function shot(page: Page, name: string): Promise<void> {
  await page.locator(".plan-unchecked").scrollIntoViewIfNeeded();
  await page
    .locator(".plan-panel")
    .screenshot({ path: test.info().outputPath(`${name}-rows.png`) });
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
}

test("a user's own balloon loop of 9V track is one reversing-loop warning naming the model, at its switch's entry, while its stem's far end is the only open end; undo and redo take it away and back", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary();
  await editor.zoom(900);
  await editor.drawTable(TABLE_FROM, TABLE_TO);
  const file = test.info().outputPath("my-balloon.ldr");
  await writeFile(file, balloonFile("my-balloon.ldr"));
  const outcome = await editor.importModel(file);
  expect(outcome.status, outcome.text).toBe("placeable");
  await editor.placeAt(outcome.item, PLACED_AT);
  await editor.escape();
  const placed = await editor.planRows();
  await shot(page, "balloon-loop-warning");
  const [pose] = await editor.poses();
  const [plan] = await editor.plans();
  const openEnds = await editor.trackEnds();
  await editor.undo();
  const undone = await editor.planRows();
  await editor.redo();
  const redone = await editor.planRows();

  const [stemEnd] = openEnds;
  if (!pose || !plan || !stemEnd) throw new Error("the balloon wasn't placed in a plan");
  const toEntry = stemEndToSwitchEntry();
  const entry = `(${planMm(stemEnd.xLdu + toEntry.x, plan.originChunkX)} mm, ${planMm(stemEnd.zLdu + toEntry.z, plan.originChunkZ)} mm)`;
  const warning = {
    rule: "trackReversing",
    severity: "warning",
    message: `Reversing loop or wye through my-balloon.ldr at stud ${pose.x / STUD_LDU}, ${pose.z / STUD_LDU}: a train can run through it and come back past ${entry} the other way, ${SHORTS}`,
  };
  expect({ x: pose.x, z: pose.z }).toEqual(PLACED_AT);
  expect(openEnds).toHaveLength(1);
  expect(ruled(placed, "trackReversing")).toEqual([warning]);
  expect(ruled(placed, "trackOpenEnd")).toHaveLength(1);
  expect(ruled(placed, "trackJoin")).toEqual([]);
  expect(ruled(undone, "trackReversing")).toEqual([]);
  expect(ruled(redone, "trackReversing")).toEqual([warning]);
});
