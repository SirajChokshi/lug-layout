import { ASSET_FETCHER, BUNDLE_LODS, PART_BUNDLE_LOADER, type IAssetFetcher } from "@brr/catalog";
import { parseGlb, readPartMesh } from "@brr/catalog/glb";
import { headingFootprints, verticalRange } from "@brr/domain";
import { ModelFile, PartShape, type BundleManifest, type ManifestPart } from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
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
    studs: glb.document.extras.studs,
    ...(part.displayColor ? { displayColor: part.displayColor } : {}),
    ...(part.producedColors ? { producedColors: part.producedColors } : {}),
    ...(part.trackEnds ? { trackEnds: part.trackEnds } : {}),
    ...(glb.document.extras.technic ? { technic: glb.document.extras.technic } : {}),
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
      });
    }
  });
});
