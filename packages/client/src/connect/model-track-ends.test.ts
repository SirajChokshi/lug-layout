import {
  ASSET_FETCHER,
  PART_BUNDLE_LOADER,
  type IAssetFetcher,
  type PartBundle,
} from "@brr/catalog";
import { MateReport, ModelConnectors, NO_INSTANCE } from "@brr/domain";
import {
  CERTIFIED_RESIDUAL_LIMIT_LDU,
  STUD_LDU,
  ZETA16_STEP_RADIANS,
  addZeta16,
  attachPose16,
  composePose16,
  pose16,
  pose16Equals,
  zeta16,
  zeta16Direction,
  zeta16ToStuds,
  type Pose16,
} from "@brr/math";
import { INSTANCE_MATRIX_FLOATS } from "@brr/render";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { TrackDrawing } from "../edit/track-drawing.ts";
import { ColorTable } from "../scene/viewer-scene.ts";
import { CONNECTION_SOLVER, SNAP_MATING } from "../tokens.ts";
import { TRACK_FAMILY } from "./finders.ts";
import {
  heldRuns,
  latticeFrame,
  modelTrackEnds,
  type ModelTrackEnds,
  type TrackInstances,
} from "./model-track-ends.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const FLOAT_LDU = 1e-6;
const OFF_FIELD_RADIANS = (0.1 * Math.PI) / 180;
const PRINTED_DECIMALS = 3;
const RESIDUAL_LIMIT_STUDS = CERTIFIED_RESIDUAL_LIMIT_LDU / STUD_LDU;
const INSIDE_THE_JOIN_LOOKUP_LDU = 0.0009;
const OUTSIDE_THE_JOIN_LOOKUP_LDU = 0.003;
const AGAINST_IT_LDU = -0.0002;
const OFF_THE_FIELD_LDU = { x: 0.0003, z: -0.0002 };
const CIRCLE_CURVES = 16;
const TURNED_A_STEP = 1;
const CURVE_PART = "ldraw:74747";
const STRAIGHT_PART = "ldraw:74746";
const NEAREST_ELEMENT_TO_A_STUD_POINT = zeta16([-21n, -20n, 59n, -20n, -21n, 10n, 0n, -10n]);
const STUD_POINT = zeta16([0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n]);
const TWENTY_STUDS_OUT = zeta16([20n, 0n, 0n, 0n, 0n, 0n, 0n, 0n]);
const PLAN_TRANSLATION_ENTRIES = [3, 11];
const SINE_ENTRIES = [2, 8];

class BundleDirectoryFetcher implements IAssetFetcher {
  async bytes(path: string): Promise<ArrayBuffer> {
    const buffer = await readFile(new URL(path, bundleRoot));
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }

  async text(path: string): Promise<string> {
    return readFile(new URL(path, bundleRoot), "utf8");
  }
}

const container = new Container();
let bundle: PartBundle;

function laid(
  drags: ReadonlyArray<readonly [readonly [number, number], readonly [number, number]]>,
): TrackDrawing {
  const drawing = new TrackDrawing(bundle, bundle.parts, new ColorTable(bundle));
  for (const [[fx, fz], [tx, tz]] of drags) {
    drawing.beginDrag(fx * STUD_LDU, fz * STUD_LDU, fx * STUD_LDU, fz * STUD_LDU);
    drawing.moveDrag(tx * STUD_LDU, tz * STUD_LDU);
    drawing.applyTrack(drawing.endDrag().change);
  }
  return drawing;
}

function asModel(drawing: TrackDrawing): TrackInstances {
  const partIndex: number[] = [];
  const matrices: number[] = [];
  for (const key of new Set(drawing.planFootprints().map((f) => f.key.chunkKey))) {
    const chunk = drawing.chunkInstances(key);
    if (!chunk) continue;
    for (let i = 0; i < chunk.count; i++) {
      const m = Array.from(
        chunk.matrices.subarray(i * INSTANCE_MATRIX_FLOATS, (i + 1) * INSTANCE_MATRIX_FLOATS),
      );
      m[3] = (m[3] ?? 0) + chunk.originX;
      m[11] = (m[11] ?? 0) + chunk.originZ;
      partIndex.push(chunk.partIndex[i] ?? 0);
      matrices.push(...m);
    }
  }
  return { count: partIndex.length, partIndex, matrices: Float64Array.from(matrices) };
}

function cornerRun(): TrackDrawing {
  return laid([
    [
      [0, 0],
      [32, 0],
    ],
    [
      [32, 0],
      [32, 48],
    ],
  ]);
}

function catalogPiece(partId: string): PartBundle["trackCatalog"]["pieces"][number] {
  const piece = bundle.trackCatalog.pieces.find((candidate) => candidate.part === partId);
  if (!piece) throw new Error(`${partId} is not in the track catalog`);
  return piece;
}

function writtenAt(pieces: ReadonlyArray<readonly [string, Pose16]>): TrackInstances {
  const partIndex: number[] = [];
  const matrices: number[] = [];
  for (const [partId, placement] of pieces) {
    const part = bundle.parts.findIndex((candidate) => candidate.id === partId);
    const frame = catalogPiece(partId).partFrame;
    const turn = (placement.heading + frame.headingHalfSteps / 2) * ZETA16_STEP_RADIANS;
    const at = zeta16ToStuds(placement.position);
    const facing = zeta16Direction(placement.heading);
    const offsetX = frame.xLdu / STUD_LDU;
    const offsetZ = frame.zLdu / STUD_LDU;
    partIndex.push(part);
    matrices.push(
      Math.cos(turn),
      0,
      -Math.sin(turn),
      STUD_LDU * (at.x + facing.x * offsetX - facing.z * offsetZ),
      0,
      1,
      0,
      -(bundle.parts[part]?.boundsMin[1] ?? 0),
      Math.sin(turn),
      0,
      Math.cos(turn),
      STUD_LDU * (at.z + facing.z * offsetX + facing.x * offsetZ),
    );
  }
  return { count: pieces.length, partIndex, matrices: Float64Array.from(matrices) };
}

function chain(start: Pose16, partIds: ReadonlyArray<string>): Array<readonly [string, Pose16]> {
  const pieces: Array<readonly [string, Pose16]> = [];
  for (const partId of partIds) {
    const previous = pieces.at(-1);
    const entry = catalogPiece(partId).connectors[0]?.pose;
    const exit = previous ? catalogPiece(previous[0]).connectors[1]?.pose : undefined;
    pieces.push([
      partId,
      previous && entry && exit ? attachPose16(entry, composePose16(previous[1], exit)) : start,
    ]);
  }
  return pieces;
}

function printed(instances: TrackInstances): TrackInstances {
  return {
    ...instances,
    matrices: instances.matrices.map((entry) => Number(entry.toFixed(PRINTED_DECIMALS))),
  };
}

function turnedCircle(): Array<readonly [string, Pose16]> {
  return chain(
    pose16(STUD_POINT, TURNED_A_STEP),
    Array.from({ length: CIRCLE_CURVES }, () => CURVE_PART),
  );
}

function inRunFrames(ends: ModelTrackEnds): TrackDrawing {
  const drawing = new TrackDrawing(bundle, bundle.parts, new ColorTable(bundle));
  const identity = latticeFrame(0, 0, 0);
  if (!identity) throw new Error("the origin is not a lattice frame");
  drawing.syncHeld(heldRuns(ends, identity, 0, 1));
  return drawing;
}

function turnedAboutItsOrigin(matrices: Float64Array, instance: number, radians: number): void {
  const o = instance * INSTANCE_MATRIX_FLOATS;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  for (const column of [0, 2]) {
    const x = matrices[o + column] ?? 0;
    const z = matrices[o + 8 + column] ?? 0;
    matrices[o + column] = cos * x - sin * z;
    matrices[o + 8 + column] = sin * x + cos * z;
  }
}

function sortedEnds(
  ends: ReadonlyArray<{ xLdu: number; zLdu: number; heading: number }>,
): number[][] {
  return ends
    .map((e) => [e.heading, e.xLdu, e.zLdu])
    .toSorted((a, b) => (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0));
}

beforeAll(async () => {
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
  const loader = container.get(PART_BUNDLE_LOADER);
  const catalogOnly = await loader.load("standard", () => false);
  const trackParts = new Set(catalogOnly.trackCatalog.pieces.map((piece) => piece.part));
  bundle = await loader.load("standard", (part) => trackParts.has(part.id));
});

describe("modelTrackEnds", () => {
  it("recovers exactly the open ends of straight track saved into a model", () => {
    const drawing = laid([
      [
        [0, 0],
        [64, 0],
      ],
    ]);
    const ends = modelTrackEnds(asModel(drawing), bundle.parts, bundle.trackCatalog);
    expect(ends.uncertified).toEqual([]);
    const recovered = ends.openEnds.map((end) => {
      const studs = zeta16ToStuds(end.pose.position);
      return { xLdu: studs.x * STUD_LDU, zLdu: studs.z * STUD_LDU, heading: end.pose.heading };
    });
    const expected = sortedEnds(drawing.openEnds());
    const actual = sortedEnds(recovered);
    expect(actual.length).toBe(expected.length);
    actual.forEach((end, i) => {
      expect(end[0]).toBe(expected[i]?.[0]);
      expect(Math.abs((end[1] ?? 0) - (expected[i]?.[1] ?? 0))).toBeLessThan(FLOAT_LDU);
      expect(Math.abs((end[2] ?? 0) - (expected[i]?.[2] ?? 0))).toBeLessThan(FLOAT_LDU);
    });
  });

  it("recovers exactly the open ends of a run that turns a corner through curves", () => {
    const drawing = cornerRun();
    const ends = modelTrackEnds(asModel(drawing), bundle.parts, bundle.trackCatalog);
    expect(ends.uncertified).toEqual([]);
    expect(ends.pieces).toHaveLength(drawing.pieceCount);
    const recovered = sortedEnds(
      ends.openEnds.map((end) => {
        const studs = zeta16ToStuds(end.pose.position);
        return { xLdu: studs.x * STUD_LDU, zLdu: studs.z * STUD_LDU, heading: end.pose.heading };
      }),
    );
    const expected = sortedEnds(drawing.openEnds());
    expect(recovered.length).toBe(expected.length);
    recovered.forEach((end, i) => {
      expect(end[0]).toBe(expected[i]?.[0]);
      expect(Math.abs((end[1] ?? 0) - (expected[i]?.[1] ?? 0))).toBeLessThan(FLOAT_LDU);
      expect(Math.abs((end[2] ?? 0) - (expected[i]?.[2] ?? 0))).toBeLessThan(FLOAT_LDU);
    });
  });

  it("identifies a run written with every matrix entry rounded to three decimals exactly as at full precision", () => {
    const instances = asModel(cornerRun());
    const exact = modelTrackEnds(instances, bundle.parts, bundle.trackCatalog);
    const ends = modelTrackEnds(printed(instances), bundle.parts, bundle.trackCatalog);
    expect(ends.uncertified).toEqual([]);
    expect(ends.pieces).toHaveLength(exact.pieces.length);
    ends.pieces.forEach((piece, i) => {
      const twin = exact.pieces[i];
      expect(twin && pose16Equals(piece.placement, twin.placement)).toBe(true);
    });
  });

  it("reports a curve turned 0.1° off the field and joins nothing to it", () => {
    const instances = asModel(cornerRun());
    const curve = Array.from(instances.partIndex).findIndex(
      (part) => bundle.parts[part]?.id === CURVE_PART,
    );
    const exact = modelTrackEnds(instances, bundle.parts, bundle.trackCatalog);
    const matrices = Float64Array.from(instances.matrices);
    turnedAboutItsOrigin(matrices, curve, OFF_FIELD_RADIANS);
    const turned = modelTrackEnds({ ...instances, matrices }, bundle.parts, bundle.trackCatalog);
    expect(turned.uncertified).toEqual([{ partId: CURVE_PART, reason: "overLimit" }]);
    expect(turned.pieces).toHaveLength(exact.pieces.length - 1);
    expect(turned.openEnds).toHaveLength(exact.openEnds.length + 2);
  });

  it("never seats a straight on the stud lattice when a neighbour's own anchor puts it at the field element 3.59e-5 LDU away", () => {
    const run = [STRAIGHT_PART, CURVE_PART, CURVE_PART, CURVE_PART];
    const seated = modelTrackEnds(
      writtenAt(chain(pose16(STUD_POINT, 0), run)),
      bundle.parts,
      bundle.trackCatalog,
    );
    const nudged = modelTrackEnds(
      writtenAt(chain(pose16(addZeta16(STUD_POINT, NEAREST_ELEMENT_TO_A_STUD_POINT), 0), run)),
      bundle.parts,
      bundle.trackCatalog,
    );
    expect(seated.pieces).toHaveLength(run.length);
    expect(nudged.pieces).toEqual([]);
    expect(nudged.uncertified).toContainEqual({ partId: STRAIGHT_PART, reason: "contradiction" });
  });

  it("seats a straight written 0.0005 LDU off the stud lattice, which double precision puts a hair beyond the limit", () => {
    const [straight] = chain(pose16(TWENTY_STUDS_OUT, 0), [STRAIGHT_PART]);
    if (!straight) throw new Error("no piece laid");
    const exact = writtenAt([straight]);
    const offByTheLimit = {
      ...exact,
      matrices: exact.matrices.map((entry, k) =>
        PLAN_TRANSLATION_ENTRIES.includes(k % INSTANCE_MATRIX_FLOATS)
          ? entry + CERTIFIED_RESIDUAL_LIMIT_LDU
          : entry,
      ),
    };
    const ends = modelTrackEnds(offByTheLimit, bundle.parts, bundle.trackCatalog);
    expect(ends.uncertified).toEqual([]);
    expect(ends.pieces).toHaveLength(1);
    expect(pose16Equals(ends.pieces[0]?.placement ?? pose16(STUD_POINT, 1), straight[1])).toBe(
      true,
    );
  });

  it("certifies a curve whose sine entries are written 0.0005 off, which double precision puts a hair beyond the limit", () => {
    const run = chain(pose16(STUD_POINT, 0), [STRAIGHT_PART, CURVE_PART]);
    const exact = writtenAt(run);
    const curve = INSTANCE_MATRIX_FLOATS;
    const offByTheLimit = {
      ...exact,
      matrices: exact.matrices.map((entry, k) =>
        k >= curve && SINE_ENTRIES.includes(k - curve)
          ? entry + CERTIFIED_RESIDUAL_LIMIT_LDU
          : entry,
      ),
    };
    for (const k of SINE_ENTRIES) {
      const written = (offByTheLimit.matrices[curve + k] ?? 0) - (exact.matrices[curve + k] ?? 0);
      expect(written).toBeGreaterThan(CERTIFIED_RESIDUAL_LIMIT_LDU);
    }
    const ends = modelTrackEnds(offByTheLimit, bundle.parts, bundle.trackCatalog);
    expect(ends.uncertified).toEqual([]);
    expect(ends.pieces.map((piece) => piece.placement)).toEqual(
      run.map(([, placement]) => placement),
    );
  });

  it("leaves a lone piece off the stud lattice unanchored, since one window candidate alone could be a stray of rounded data", () => {
    const [lone] = chain(pose16(STUD_POINT, 1), [CURVE_PART]);
    if (!lone) throw new Error("no piece laid");
    const ends = modelTrackEnds(writtenAt([lone]), bundle.parts, bundle.trackCatalog);
    expect(ends.uncertified).toEqual([{ partId: CURVE_PART, reason: "noAnchor" }]);
  });

  it("identifies a 22.5°-turned circle written at three decimals in one run frame with its exact relative poses", () => {
    const circle = turnedCircle();
    const ends = modelTrackEnds(printed(writtenAt(circle)), bundle.parts, bundle.trackCatalog);
    expect(ends.pieces).toEqual([]);
    expect(ends.uncertified).toEqual([]);
    const [run] = ends.runs;
    if (!run) throw new Error("no run frame");
    const root = circle[0]?.[1];
    if (!root) throw new Error("no root piece");
    const truth = circle.map(([, pose]) => `${pose.heading}:${pose.position.join(",")}`).toSorted();
    const shifted = run.pieces
      .map((piece) => {
        const at = addZeta16(piece.placement.position, root.position);
        return `${piece.placement.heading}:${at.join(",")}`;
      })
      .toSorted();
    expect(shifted).toEqual(truth);
    const rootStuds = zeta16ToStuds(root.position);
    expect(Math.abs(run.originStuds.x - rootStuds.x)).toBeLessThanOrEqual(RESIDUAL_LIMIT_STUDS);
    expect(Math.abs(run.originStuds.z - rootStuds.z)).toBeLessThanOrEqual(RESIDUAL_LIMIT_STUDS);
    const drawing = inRunFrames(ends);
    expect([drawing.joinedPairs(), drawing.openEnds().length]).toEqual([CIRCLE_CURVES, 0]);
  });

  it("refuses a whole run frame when no one translation fits it, though a moved piece still joins, and splits it when a join breaks", () => {
    const moved = (shifts: ReadonlyArray<readonly [number, number]>): ModelTrackEnds => {
      const matrices = Float64Array.from(writtenAt(turnedCircle()).matrices);
      for (let i = 0; i < CIRCLE_CURVES; i++) {
        matrices[i * INSTANCE_MATRIX_FLOATS + 3] =
          (matrices[i * INSTANCE_MATRIX_FLOATS + 3] ?? 0) + OFF_THE_FIELD_LDU.x;
        matrices[i * INSTANCE_MATRIX_FLOATS + 11] =
          (matrices[i * INSTANCE_MATRIX_FLOATS + 11] ?? 0) + OFF_THE_FIELD_LDU.z;
      }
      for (const [piece, shiftLdu] of shifts) {
        const o = piece * INSTANCE_MATRIX_FLOATS + 3;
        matrices[o] = (matrices[o] ?? 0) + shiftLdu;
      }
      const instances = { ...writtenAt(turnedCircle()), matrices };
      return modelTrackEnds(instances, bundle.parts, bundle.trackCatalog);
    };
    expect(moved([]).runs.map((run) => run.pieces.length)).toEqual([CIRCLE_CURVES]);
    const inside = moved([
      [0, INSIDE_THE_JOIN_LOOKUP_LDU],
      [CIRCLE_CURVES / 2, AGAINST_IT_LDU],
    ]);
    expect(inside.runs).toEqual([]);
    expect(inside.uncertified.map((piece) => piece.reason)).toEqual(
      Array.from({ length: CIRCLE_CURVES }, () => "contradiction"),
    );
    const outside = moved([[0, OUTSIDE_THE_JOIN_LOOKUP_LDU]]);
    expect(outside.runs.map((run) => run.pieces.length)).toEqual([CIRCLE_CURVES - 1]);
    expect(outside.uncertified).toEqual([{ partId: CURVE_PART, reason: "noAnchor" }]);
    expect(inRunFrames(outside).openEnds()).toHaveLength(2);
  });

  it("refuses a whole run frame when one of its ends has two partners, as a duplicated piece gives", () => {
    const circle = turnedCircle();
    const duplicated = circle[0];
    if (!duplicated) throw new Error("no piece to duplicate");
    const ends = modelTrackEnds(
      printed(writtenAt([...circle, duplicated])),
      bundle.parts,
      bundle.trackCatalog,
    );
    expect(ends.runs).toEqual([]);
    expect(ends.uncertified.map((piece) => piece.reason)).toEqual(
      Array.from({ length: CIRCLE_CURVES + 1 }, () => "contradiction"),
    );
  });

  it("never joins a run frame's end to another run frame or to world track at the same exact pose", () => {
    const open = chain(pose16(STUD_POINT, TURNED_A_STEP), [CURVE_PART, CURVE_PART, CURVE_PART]);
    const ends = modelTrackEnds(printed(writtenAt(open)), bundle.parts, bundle.trackCatalog);
    const [run] = ends.runs;
    const first = run?.pieces[0];
    if (!run || !first) throw new Error("no run frame");
    const drawing = new TrackDrawing(bundle, bundle.parts, new ColorTable(bundle));
    const identity = latticeFrame(0, 0, 0);
    if (!identity) throw new Error("the origin is not a lattice frame");
    drawing.syncHeld([...heldRuns(ends, identity, 0, 1), ...heldRuns(ends, identity, 0, 2)]);
    const internalJoins = 2 * (run.pieces.length - 1);
    expect(drawing.joinedPairs()).toBe(internalJoins);
    const straight = catalogPiece(STRAIGHT_PART);
    const runEnd = composePose16(
      first.placement,
      catalogPiece(CURVE_PART).connectors[0]?.pose ?? first.placement,
    );
    const exit = straight.connectors[1]?.pose;
    if (!exit) throw new Error("the straight has no exit");
    drawing.applyTrack(
      drawing.pieceChange(bundle.trackCatalog.pieces.indexOf(straight), attachPose16(exit, runEnd)),
    );
    expect(drawing.joinedPairs()).toBe(internalJoins);
    expect(drawing.openEnds()).toHaveLength(2 * 2 + 2);
  });

  it("joins a model's track to another model's exactly where the laid run continues", () => {
    const mating = container.get(SNAP_MATING);
    const solver = container.get(CONNECTION_SOLVER);
    const run = modelTrackEnds(
      asModel(
        laid([
          [
            [0, 0],
            [32, 0],
          ],
        ]),
      ),
      bundle.parts,
      bundle.trackCatalog,
    );
    const next = modelTrackEnds(
      asModel(
        laid([
          [
            [32, 0],
            [64, 0],
          ],
        ]),
      ),
      bundle.parts,
      bundle.trackCatalog,
    );
    const none = { count: 0, partIndex: [], matrices: new Float64Array(0) };
    const RUN = 1;
    solver.insert(
      ModelConnectors.fromParts([], none, mating, run.openEnds),
      { x: 0, z: 0, yPlates: 0, rot: 0 },
      RUN,
    );
    const held = ModelConnectors.fromParts([], none, mating, next.openEnds);
    const report = new MateReport();
    solver.evaluate(held, { x: 0, z: 0, yPlates: 0, rot: 0 }, report);
    expect({
      mate: [report.count, report.family[0], report.partner[0]],
      heldEndNamesItsPiece: (report.instance[0] ?? NO_INSTANCE) !== NO_INSTANCE,
      partnerEndNamesItsPiece: (report.partnerInstance[0] ?? NO_INSTANCE) !== NO_INSTANCE,
    }).toEqual({
      mate: [1, TRACK_FAMILY, RUN],
      heldEndNamesItsPiece: true,
      partnerEndNamesItsPiece: true,
    });
    solver.evaluate(held, { x: STUD_LDU, z: 0, yPlates: 0, rot: 0 }, report);
    expect(report.count).toBe(0);
  });
});
