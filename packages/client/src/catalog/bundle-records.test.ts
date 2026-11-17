import { ASSET_FETCHER, BUNDLE_LODS, PART_BUNDLE_LOADER, type IAssetFetcher } from "@brr/catalog";
import { parseGlb, readPartMesh } from "@brr/catalog/glb";
import {
  HALF_PLANE_FLOATS,
  headingFootprints,
  placedPlanCells,
  verticalRange,
  type BaseCells,
} from "@brr/domain";
import {
  STUD_LDU,
  ZETA16_COEFFICIENT_COUNT,
  ZETA16_ORDER,
  composePose16,
  pose16,
  zeta16,
  zeta16ToStuds,
  type Pose16,
} from "@brr/math";
import {
  ModelFile,
  PartShape,
  TrackSilhouette,
  type BundleManifest,
  type ManifestPart,
  type TrackPartFrame,
} from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { placedPlan, planTriangles } from "../edit/track-footprint.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);

class BundleDirectoryFetcher implements IAssetFetcher {
  async bytes(path: string): Promise<ArrayBuffer> {
    const buffer = await readFile(new URL(path, bundleRoot));
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }

  async text(path: string): Promise<string> {
    return readFile(new URL(path, bundleRoot), "utf8");
  }
}

const fetcher = new BundleDirectoryFetcher();
const manifests = new Map<string, BundleManifest>();

beforeAll(async () => {
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  container.rebind(ASSET_FETCHER).toConstantValue(fetcher);
  const loader = container.get(PART_BUNDLE_LOADER);
  for (const lod of BUNDLE_LODS) manifests.set(lod, await loader.loadManifest(lod));
});

function manifestOf(lod: string): BundleManifest {
  const manifest = manifests.get(lod);
  if (!manifest) throw new Error(`no ${lod} manifest`);
  return manifest;
}

async function glbOf(lod: string, part: ManifestPart) {
  return parseGlb(await fetcher.bytes(`${lod}/${part.file}`), part.file);
}

async function shapeInBundle(lod: string, part: ManifestPart): Promise<PartShape> {
  const glb = await glbOf(lod, part);
  return {
    id: part.id,
    title: part.title,
    role: part.role,
    file: part.file,
    bounds: glb.document.extras.bounds,
    baseplate: part.baseplate,
    studs: glb.document.extras.studs,
    ...(part.displayColor ? { displayColor: part.displayColor } : {}),
    ...(part.producedColors ? { producedColors: part.producedColors } : {}),
    ...(part.trackEnds ? { trackEnds: part.trackEnds } : {}),
    ...(glb.document.extras.technic ? { technic: glb.document.extras.technic } : {}),
  };
}

const HEADING_RADIANS = (2 * Math.PI) / ZETA16_ORDER;
const HALF_STEP_RADIANS = HEADING_RADIANS / 2;
const POSITION_FLOATS = 3;
const NO_CLIP_PLANES = new Float64Array(0);
const SAMPLE_POSITIONS: ReadonlyArray<ReadonlyArray<number>> = [
  [0],
  [3, 1, 0, 0, -2],
  [-7, 0, 2, -1, 4, 0, 1],
];

function samplePose(coefficients: ReadonlyArray<number>, heading: number): Pose16 {
  const full = Array.from({ length: ZETA16_COEFFICIENT_COUNT }, (_, k) =>
    BigInt(coefficients[k] ?? 0),
  );
  return pose16(zeta16(full), heading);
}

function connectorPlanes(placement: Pose16, connectors: ReadonlyArray<Pose16>): Float64Array {
  const planes = new Float64Array(connectors.length * HALF_PLANE_FLOATS);
  connectors.forEach((connector, i) => {
    const end = composePose16(placement, connector);
    const at = zeta16ToStuds(end.position);
    const nx = Math.cos(end.heading * HEADING_RADIANS);
    const nz = Math.sin(end.heading * HEADING_RADIANS);
    planes.set([nx, nz, (nx * at.x + nz * at.z) * STUD_LDU], i * HALF_PLANE_FLOATS);
  });
  return planes;
}

function meshPlanCells(
  positions: Float32Array,
  groups: ReadonlyArray<{ readonly indices: Uint32Array }>,
  placement: Pose16,
  frame: TrackPartFrame,
  clip: Float64Array,
): BaseCells {
  const studs = zeta16ToStuds(placement.position);
  const theta = placement.heading * HEADING_RADIANS;
  const phi = theta + frame.headingHalfSteps * HALF_STEP_RADIANS;
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  const x = studs.x * STUD_LDU + Math.cos(theta) * frame.xLdu - Math.sin(theta) * frame.zLdu;
  const z = studs.z * STUD_LDU + Math.sin(theta) * frame.xLdu + Math.cos(theta) * frame.zLdu;
  const world: number[] = [];
  for (const { indices } of groups) {
    for (let t = 0; t + 3 <= indices.length; t += 3) {
      const corners = [0, 1, 2].map((k) => (indices[t + k] ?? 0) * POSITION_FLOATS);
      const [a = 0, b = 0, d = 0] = corners;
      const area =
        ((positions[b] ?? 0) - (positions[a] ?? 0)) *
          ((positions[d + 2] ?? 0) - (positions[a + 2] ?? 0)) -
        ((positions[b + 2] ?? 0) - (positions[a + 2] ?? 0)) *
          ((positions[d] ?? 0) - (positions[a] ?? 0));
      if (area === 0) continue;
      for (const v of corners) {
        const px = positions[v] ?? 0;
        const pz = positions[v + 2] ?? 0;
        world.push(c * px - s * pz + x, s * px + c * pz + z);
      }
    }
  }
  return placedPlanCells(Float64Array.from(world), { cos: 1, sin: 0, x: 0, z: 0 }, clip);
}

function cellKeys(cells: BaseCells): ReadonlyArray<string> {
  return Array.from(
    { length: cells.count },
    (_, c) => `${cells.cellX[c]},${cells.cellZ[c]}`,
  ).toSorted();
}

describe.each(BUNDLE_LODS)("the %s bundle's records", (lod) => {
  it("give every model the shape of each part it places, as its GLB and manifest entry hold it", async () => {
    const manifest = manifestOf(lod);
    const parts = new Map(manifest.parts.map((part) => [part.id, part]));
    for (const entry of manifest.models) {
      const model = decodedOrThrow(
        decode(ModelFile, JSON.parse(await fetcher.text(`${lod}/${entry.file}`))),
        entry.file,
      );
      for (const shape of model.shapes) {
        const part = parts.get(shape.id);
        if (!part) throw new Error(`${entry.name}: ${shape.id} is not in the part table`);
        expect(shape).toEqual(await shapeInBundle(lod, part));
      }
    }
  });

  it("give every ground, road and track part a shape file of its own", async () => {
    const manifest = manifestOf(lod);
    const ids = manifest.catalogParts.map((part) => part.id).toSorted();
    expect(ids).toEqual(
      manifest.parts
        .filter((part) => part.role === "ground" || part.role === "road" || part.role === "track")
        .map((part) => part.id)
        .toSorted(),
    );
    for (const part of manifest.catalogParts) {
      const shape = decodedOrThrow(
        decode(PartShape, JSON.parse(await fetcher.text(`${lod}/${part.shape.file}`))),
        part.shape.file,
      );
      expect(shape).toEqual(await shapeInBundle(lod, part));
    }
  });

  it("hold each track piece's footprints at all 16 headings and its height range, as its mesh gives them", async () => {
    const manifest = manifestOf(lod);
    const parts = new Map(manifest.parts.map((part) => [part.id, part]));
    expect(manifest.trackShapes.map((shape) => shape.piece)).toEqual(
      manifest.trackCatalog.pieces.map((piece) => piece.id),
    );
    for (const piece of manifest.trackCatalog.pieces) {
      const part = parts.get(piece.part);
      if (!part) throw new Error(`track piece ${piece.id} has no part`);
      const { positions } = readPartMesh(await glbOf(lod, part), part.file);
      const [minY, maxY] = verticalRange(positions);
      expect(manifest.trackShapes.find((shape) => shape.piece === piece.id)).toEqual({
        piece: piece.id,
        footprints: Array.from(headingFootprints(positions, piece.partFrame.headingHalfSteps)),
        minY,
        maxY,
        silhouette: { file: expect.stringMatching(/^silhouette-/u) },
      });
    }
  });

  it("hold each track piece's plan and support silhouettes, covering exactly the cells its mesh covers, whole and within its connector span, at every pose", async () => {
    const manifest = manifestOf(lod);
    const parts = new Map(manifest.parts.map((part) => [part.id, part]));
    const shapes = new Map(manifest.trackShapes.map((shape) => [shape.piece, shape]));
    for (const piece of manifest.trackCatalog.pieces) {
      const part = parts.get(piece.part);
      const shape = shapes.get(piece.id);
      if (!part || !shape) throw new Error(`track piece ${piece.id} has no part or shape`);
      const { positions, groups } = readPartMesh(await glbOf(lod, part), part.file);
      const silhouette = decodedOrThrow(
        decode(TrackSilhouette, JSON.parse(await fetcher.text(`${lod}/${shape.silhouette.file}`))),
        shape.silhouette.file,
      );
      expect(silhouette.piece).toBe(piece.id);
      const plan = planTriangles(silhouette.plan);
      const support = planTriangles(silhouette.support);
      const connectors = piece.connectors.map((connector) => connector.pose);
      for (const coefficients of SAMPLE_POSITIONS) {
        for (let heading = 0; heading < ZETA16_ORDER; heading++) {
          const placement = samplePose(coefficients, heading);
          const frame = piece.partFrame;
          const where = `${piece.id} at heading ${heading}`;
          const labelled = (cells: BaseCells) => ({ where, cells: cellKeys(cells) });
          const placed = placedPlan(plan, support, placement, frame);
          expect(labelled(placed.cells)).toEqual(
            labelled(meshPlanCells(positions, groups, placement, frame, NO_CLIP_PLANES)),
          );
          expect(labelled(placed.support)).toEqual(
            labelled(
              meshPlanCells(
                positions,
                groups,
                placement,
                frame,
                connectorPlanes(placement, connectors),
              ),
            ),
          );
        }
      }
    }
  }, 60_000);
});
