import {
  ASSET_FETCHER,
  BUNDLE_LODS,
  PART_BUNDLE_LOADER,
  type IAssetFetcher,
  type IPartBundleLoader,
} from "@brr/catalog";
import { parseGlb, readPartMesh } from "@brr/catalog/glb";
import { headingFootprints, planHull, verticalRange } from "@brr/domain";
import { pieceFrameOutline } from "@brr/domain/piece-outline";
import {
  ModelFile,
  PartShape,
  PlanOutlinesFile,
  type BundleManifest,
  type ManifestPart,
} from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import outlinesJson from "../../../../docs/verified-facts/plan-outlines.json" with { type: "json" };
import { mainThreadModules } from "../client.module.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const BUNDLE_SWEEP_TIMEOUT_MS = 60_000;

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
const outlines = new Map(
  decodedOrThrow(decode(PlanOutlinesFile, outlinesJson), "plan-outlines.json").outlines.map(
    (outline) => [outline.part, outline.rings],
  ),
);
const manifests = new Map<string, BundleManifest>();
let loader: IPartBundleLoader;

beforeAll(async () => {
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  container.rebind(ASSET_FETCHER).toConstantValue(fetcher);
  loader = container.get(PART_BUNDLE_LOADER);
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
    studs: glb.document.extras.studs,
    ...(part.displayColor ? { displayColor: part.displayColor } : {}),
    ...(part.producedColors ? { producedColors: part.producedColors } : {}),
    ...(part.trackEnds ? { trackEnds: part.trackEnds } : {}),
    ...(glb.document.extras.technic ? { technic: glb.document.extras.technic } : {}),
    ...(glb.document.extras.rolling ? { rolling: glb.document.extras.rolling } : {}),
    ...(glb.document.extras.topSurface ? { topSurface: glb.document.extras.topSurface } : {}),
    ...(outlines.has(part.id) ? { outline: outlines.get(part.id) } : {}),
  };
}

describe.each(BUNDLE_LODS)("the %s bundle's records", (lod) => {
  it(
    "give every model the shape of each part it places, as its GLB and manifest entry hold it",
    async () => {
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
    },
    BUNDLE_SWEEP_TIMEOUT_MS,
  );

  it("load a placed part's rolling surfaces into its model record as its GLB measured them", async () => {
    const manifest = manifestOf(lod);
    const parts = new Map(manifest.parts.map((part) => [part.id, part]));
    for (const entry of manifest.models) {
      const record = await loader.loadModelRecord(lod, entry.name);
      const rolling = record.parts.find((shape) => (shape.rolling?.surfaces.length ?? 0) > 0);
      const part = rolling && parts.get(rolling.id);
      if (!rolling || !part) continue;
      expect(rolling.rolling).toEqual((await glbOf(lod, part)).document.extras.rolling);
      return;
    }
    throw new Error(`no model in the ${lod} bundle places a part with a rolling surface`);
  });

  it("give every ground, road, track and ramp part a shape file of its own", async () => {
    const manifest = manifestOf(lod);
    const ramps = new Set(manifest.levelCrossing.ramps.map((ramp) => ramp.part));
    const ids = manifest.catalogParts.map((part) => part.id).toSorted();
    expect(ids).toEqual(
      manifest.parts
        .filter(
          (part) =>
            part.role === "ground" ||
            part.role === "road" ||
            part.role === "track" ||
            ramps.has(part.id),
        )
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

  it("hold each track piece's footprints at all 16 headings, its plan hull, its height range and its exact outline in its own frame", async () => {
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
      const outline = outlines.get(piece.part);
      if (!outline) throw new Error(`track part ${piece.part} has no plan outline`);
      expect(manifest.trackShapes.find((shape) => shape.piece === piece.id)).toEqual({
        piece: piece.id,
        footprints: Array.from(headingFootprints(positions, piece.partFrame.headingHalfSteps)),
        hull: Array.from(planHull(positions, piece.partFrame.headingHalfSteps)),
        minY,
        maxY,
        outline: pieceFrameOutline(outline, piece.partFrame),
      });
    }
  });
});
