import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { EditorPage, TRACK_ITEM, type LatticePoint } from "./editor-page.ts";

const POINT_SPACING_LDU = 40;
const HAND_WOBBLE_LDU = 24;
const HAND_WAVELENGTHS_LDU = [460, 1220] as const;
const STRAIGHT_RUN_LDU = 1280;
const APPROACH_LDU = 960;
const BEND_RADIUS_LDU = 800;
const COTTAGE_NAME = "custom-cottage.ldr";
const COTTAGE_AT: LatticePoint = { x: 0, z: 0 };
const WALL_HALF_LDU = 80;

function line(from: LatticePoint, to: LatticePoint): LatticePoint[] {
  const steps = Math.max(
    1,
    Math.ceil(Math.hypot(to.x - from.x, to.z - from.z) / POINT_SPACING_LDU),
  );
  return Array.from({ length: steps + 1 }, (_v, i) => ({
    x: from.x + ((to.x - from.x) * i) / steps,
    z: from.z + ((to.z - from.z) * i) / steps,
  }));
}

function arc(centre: LatticePoint, radius: number, fromDeg: number, toDeg: number): LatticePoint[] {
  const sweep = ((toDeg - fromDeg) * Math.PI) / 180;
  const steps = Math.max(1, Math.ceil((Math.abs(sweep) * radius) / POINT_SPACING_LDU));
  return Array.from({ length: steps + 1 }, (_v, i) => {
    const angle = (fromDeg * Math.PI) / 180 + (sweep * i) / steps;
    return { x: centre.x + radius * Math.cos(angle), z: centre.z + radius * Math.sin(angle) };
  });
}

function chained(...parts: ReadonlyArray<ReadonlyArray<LatticePoint>>): LatticePoint[] {
  return parts.flatMap((part, i) => (i === 0 ? part : part.slice(1)));
}

function byHand(points: ReadonlyArray<LatticePoint>, phase: number): LatticePoint[] {
  let travelled = 0;
  const arcs = points.map((point, i) => {
    const previous = points[i - 1];
    if (previous) travelled += Math.hypot(point.x - previous.x, point.z - previous.z);
    return travelled;
  });
  return points.map((point, i) => {
    const previous = points[Math.max(0, i - 1)] ?? point;
    const next = points[Math.min(points.length - 1, i + 1)] ?? point;
    const length = Math.hypot(next.x - previous.x, next.z - previous.z) || 1;
    const s = arcs[i] ?? 0;
    const taper = Math.min(1, s / BEND_RADIUS_LDU, (travelled - s) / BEND_RADIUS_LDU);
    const offset =
      (HAND_WOBBLE_LDU *
        taper *
        HAND_WAVELENGTHS_LDU.reduce(
          (sum, wavelength) => sum + Math.sin((2 * Math.PI * s) / wavelength + phase),
          0,
        )) /
      HAND_WAVELENGTHS_LDU.length;
    return {
      x: point.x - (offset * (next.z - previous.z)) / length,
      z: point.z + (offset * (next.x - previous.x)) / length,
    };
  });
}

function wall(x: number, y: number, z: number, turned: boolean): string {
  return `1 15 ${x} ${y} ${z} ${turned ? "0 0 1 0 1 0 -1 0 0" : "1 0 0 0 1 0 0 0 1"} 3001.dat`;
}

function course(y: number): string[] {
  return [
    wall(-40, y, -60, false),
    wall(40, y, -60, false),
    wall(-40, y, 60, false),
    wall(40, y, 60, false),
    wall(-60, y, 0, true),
    wall(60, y, 0, true),
  ];
}

function customCottage(): string {
  return [
    "0 Custom cottage built for the track stroke test",
    `0 Name: ${COTTAGE_NAME}`,
    "0 Author: lug-layout e2e (generated at test time)",
    "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
    "1 2 0 0 0 1 0 0 0 1 0 0 0 1 3867.dat",
    ...course(-24),
    ...course(-48),
    "",
  ].join("\n");
}

test("an oval drawn by hand in two strokes lays along both and closes with every end joined", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.zoom(500);
  await editor.choose(TRACK_ITEM);
  const top = -BEND_RADIUS_LDU;
  const west = -STRAIGHT_RUN_LDU / 2;
  const east = STRAIGHT_RUN_LDU / 2;

  const out = await editor.strokeTrack(
    byHand(
      chained(
        line({ x: west, z: top }, { x: east, z: top }),
        arc({ x: east, z: 0 }, BEND_RADIUS_LDU, -90, 90),
        line({ x: east, z: -top }, { x: west, z: -top }),
      ),
      0.4,
    ),
  );
  expect(out).toMatchObject({ lastCommit: "laid", openEnds: 2 });
  const ends = await editor.trackEnds();
  expect(ends.map((end) => [end.xLdu, end.zLdu])).toEqual(
    expect.arrayContaining([
      [west, top],
      [west, -top],
    ]),
  );

  const back = await editor.strokeTrack(
    byHand(
      chained([{ x: west, z: -top }], arc({ x: west, z: 0 }, BEND_RADIUS_LDU, 90, 270), [
        { x: west, z: top },
      ]),
      1.9,
    ),
  );
  expect(back.lastCommit).toBe("joined");
  expect(back.openEnds).toBe(0);
  expect(back.joins).toBe(back.pieces);

  await editor.waitForFarTierAndMeshesSettled();
  await page.screenshot({ path: test.info().outputPath("hand-drawn-oval.png") });
});

test("a stroke through an imported custom cottage stops before its walls and says what it would hit", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary();
  const file = test.info().outputPath(COTTAGE_NAME);
  await writeFile(file, customCottage());
  const imported = await editor.importModel(file);
  expect(imported.status, imported.text).toBe("placeable");
  await editor.zoom(500);
  await editor.placeAt(imported.item, COTTAGE_AT);
  await editor.escape();
  await editor.choose(TRACK_ITEM);

  const run = await editor.strokeTrack(
    byHand(line({ x: -APPROACH_LDU, z: 0 }, { x: APPROACH_LDU, z: 0 }), 0.8),
  );

  expect(run.lastCommit).toBe("laid");
  expect(run.pieces).toBeGreaterThan(0);
  expect(await editor.toolHint()).toContain(`run into ${COTTAGE_NAME}`);
  const reached = Math.max(...(await editor.trackEnds()).map((end) => end.xLdu));
  expect(reached).toBeLessThanOrEqual(COTTAGE_AT.x - WALL_HALF_LDU);

  await editor.waitForFarTierAndMeshesSettled();
  await page.screenshot({ path: test.info().outputPath("stroke-stops-at-cottage.png") });
});
