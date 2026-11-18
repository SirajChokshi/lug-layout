import {
  ASSET_FETCHER,
  PART_BUNDLE_LOADER,
  type IAssetFetcher,
  type PartBundle,
} from "@brr/catalog";
import { MateReport, ModelConnectors } from "@brr/domain";
import { STUD_LDU, zeta16ToStuds } from "@brr/math";
import { INSTANCE_MATRIX_FLOATS } from "@brr/render";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { TrackDrawing } from "../edit/track-drawing.ts";
import { ColorTable } from "../scene/viewer-scene.ts";
import { CONNECTION_SOLVER, SNAP_MATING } from "../tokens.ts";
import { TRACK_FAMILY } from "./finders.ts";
import { modelTrackEnds, type TrackInstances } from "./model-track-ends.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const FLOAT_LDU = 1e-6;

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
    drawing.endDrag();
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

  it("reports a curve whose part frame is a half step off a quarter turn, instead of guessing its ends", () => {
    const drawing = laid([
      [
        [0, 0],
        [32, 0],
      ],
      [
        [32, 0],
        [32, 48],
      ],
    ]);
    const ends = modelTrackEnds(asModel(drawing), bundle.parts, bundle.trackCatalog);
    expect(ends.uncertified.length).toBeGreaterThan(0);
    expect(ends.pieces.length + ends.uncertified.length).toBe(drawing.pieceCount);
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
    solver.insert(ModelConnectors.fromParts([], none, mating, run.openEnds), {
      x: 0,
      z: 0,
      yPlates: 0,
      rot: 0,
    });
    const held = ModelConnectors.fromParts([], none, mating, next.openEnds);
    const report = new MateReport();
    solver.evaluate(held, { x: 0, z: 0, yPlates: 0, rot: 0 }, report);
    expect([report.count, report.family[0]]).toEqual([1, TRACK_FAMILY]);
    solver.evaluate(held, { x: STUD_LDU, z: 0, yPlates: 0, rot: 0 }, report);
    expect(report.count).toBe(0);
  });
});
