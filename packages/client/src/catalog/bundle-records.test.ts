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
  BundleIndex,
  decodePlanGlyph,
  ModelFile,
  PartShape,
  type BundleManifest,
  type ManifestPart,
  type PlanOutline,
  type PlanPoint,
} from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { Container } from "inversify";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { mainThreadModules } from "../client.module.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const fixtureBundleRoot = new URL(
  "../../../../tools/asset-pipeline/fixture-bundle/standard/",
  import.meta.url,
);
const MIN_RING_POINTS = 3;
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

async function catalogOutlines(lod: string): Promise<ReadonlyMap<string, PlanOutline>> {
  const outlines = new Map<string, PlanOutline>();
  for (const part of manifestOf(lod).catalogParts) {
    const shape = decodedOrThrow(
      decode(PartShape, JSON.parse(await fetcher.text(`${lod}/${part.shape.file}`))),
      part.shape.file,
    );
    if (shape.outline) outlines.set(part.id, shape.outline);
  }
  return outlines;
}

function cross(a: PlanPoint, b: PlanPoint, c: PlanPoint): bigint {
  return (
    (BigInt(b[0]) - BigInt(a[0])) * (BigInt(c[1]) - BigInt(a[1])) -
    (BigInt(b[1]) - BigInt(a[1])) * (BigInt(c[0]) - BigInt(a[0]))
  );
}

function strictlyBetween(a: PlanPoint, point: PlanPoint, b: PlanPoint): boolean {
  const along = (from: PlanPoint, to: PlanPoint) =>
    (BigInt(point[0]) - BigInt(from[0])) * (BigInt(to[0]) - BigInt(from[0])) +
    (BigInt(point[1]) - BigInt(from[1])) * (BigInt(to[1]) - BigInt(from[1]));
  return along(a, b) > 0n && along(b, a) > 0n;
}

function twiceArea(ring: ReadonlyArray<PlanPoint>): bigint {
  const origin = ring[0];
  if (!origin) return 0n;
  let sum = 0n;
  for (let i = 1; i + 1 < ring.length; i++) {
    const b = ring[i];
    const c = ring[i + 1];
    if (b && c) sum += cross(origin, b, c);
  }
  return sum;
}

function isOnOneLine(ring: ReadonlyArray<PlanPoint>): boolean {
  const first = ring[0];
  const far = ring.find((point) => first && (point[0] !== first[0] || point[1] !== first[1]));
  return !first || !far || ring.every((point) => cross(first, far, point) === 0n);
}

function keepsOrderOf(kept: ReadonlyArray<PlanPoint>, ring: ReadonlyArray<PlanPoint>): boolean {
  return ring.some((_, start) => {
    let k = 0;
    for (let i = 0; i < ring.length && k < kept.length; i++) {
      const point = ring[(start + i) % ring.length];
      const want = kept[k];
      if (point && want && point[0] === want[0] && point[1] === want[1]) k++;
    }
    return k === kept.length;
  });
}

function degenerateProblems(outline: PlanOutline): ReadonlyArray<string> {
  return outline.flatMap((ring, r) => [
    ...(ring.length < MIN_RING_POINTS ? [`ring ${r} has ${ring.length} points`] : []),
    ...ring.flatMap((point, i) => {
      const previous = ring[(i + ring.length - 1) % ring.length] ?? point;
      const next = ring[(i + 1) % ring.length] ?? point;
      const flat = cross(previous, point, next) === 0n;
      return flat && !strictlyBetween(previous, point, next)
        ? [`ring ${r} point ${i} ${point}`]
        : [];
    }),
  ]);
}

async function shippedOutlines(
  read: (file: string) => Promise<string>,
): Promise<ReadonlyArray<readonly [string, PlanOutline]>> {
  const index = decodedOrThrow(
    decode(BundleIndex, JSON.parse(await read("manifest.json"))),
    "manifest.json",
  );
  const shipped: Array<readonly [string, PlanOutline]> = index.trackShapes.map((shape) => [
    `track shape ${shape.piece}`,
    shape.outline,
  ]);
  for (const part of index.catalogParts) {
    const shape = decodedOrThrow(
      decode(PartShape, JSON.parse(await read(part.shape.file))),
      part.shape.file,
    );
    if (shape.outline) shipped.push([`shape file ${part.shape.file}`, shape.outline]);
  }
  for (const entry of index.models) {
    const model = decodedOrThrow(decode(ModelFile, JSON.parse(await read(entry.file))), entry.file);
    for (const shape of model.shapes) {
      if (shape.outline) shipped.push([`model ${entry.name} shape ${shape.id}`, shape.outline]);
    }
  }
  return shipped;
}

function decodedGlyph(glyph: Uint8Array | undefined): boolean | string {
  return glyph === undefined ? "no glyph" : decodePlanGlyph(glyph).ok;
}

function glyphFiles({ parts, models }: BundleManifest): ReadonlyArray<string> {
  return [...parts, ...models].flatMap((item) => (item.glyph ? [item.glyph.file] : []));
}

async function shapeInBundle(
  lod: string,
  part: ManifestPart,
  outline: PlanOutline | undefined,
): Promise<PartShape> {
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
    ...(outline ? { outline } : {}),
  };
}

describe.each(BUNDLE_LODS)("the %s bundle's records", (lod) => {
  it(
    "give every model the shape of each part it places, as its GLB and manifest entry hold it",
    async () => {
      const manifest = manifestOf(lod);
      const parts = new Map(manifest.parts.map((part) => [part.id, part]));
      const outlines = await catalogOutlines(lod);
      for (const entry of manifest.models) {
        const model = decodedOrThrow(
          decode(ModelFile, JSON.parse(await fetcher.text(`${lod}/${entry.file}`))),
          entry.file,
        );
        for (const shape of model.shapes) {
          const part = parts.get(shape.id);
          if (!part) throw new Error(`${entry.name}: ${shape.id} is not in the part table`);
          expect(shape).toEqual(await shapeInBundle(lod, part, outlines.get(part.id)));
        }
      }
    },
    BUNDLE_SWEEP_TIMEOUT_MS,
  );

  it("ship the LDraw each model is baked from: its pinned source with only the errata its entry lists", async () => {
    const unpinned: string[] = [];
    for (const entry of manifestOf(lod).models) {
      const { text } = await loader.loadModelLdraw(lod, entry.name);
      const lines = text.split(/(?<=\n)/u);
      for (const erratum of entry.errata ?? []) {
        const line = lines[erratum.line - 1] ?? "";
        const content = line.replace(/\r?\n$/u, "");
        expect(content, `${entry.name} line ${erratum.line}`).toBe(erratum.to);
        lines[erratum.line - 1] = `${erratum.from}${line.slice(content.length)}`;
      }
      const sha256 = createHash("sha256").update(lines.join(""), "utf8").digest("hex");
      if (sha256 !== entry.sha256) unpinned.push(entry.name);
    }

    expect(unpinned).toEqual([]);
  });

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
      const { outline, ...shape } = decodedOrThrow(
        decode(PartShape, JSON.parse(await fetcher.text(`${lod}/${part.shape.file}`))),
        part.shape.file,
      );
      expect(shape).toEqual(await shapeInBundle(lod, part, undefined));
      expect({ part: part.id, outlined: outline !== undefined }).toEqual({
        part: part.id,
        outlined: part.role === "track" || ramps.has(part.id),
      });
    }
  });

  it("hold each track piece's footprints at all 16 headings, its plan hull, its height range and its outline turned into its own frame, keeping each ring's exact area and dropping only rings that lie on one line and points that enclose nothing", async () => {
    const manifest = manifestOf(lod);
    const parts = new Map(manifest.parts.map((part) => [part.id, part]));
    const outlines = await catalogOutlines(lod);
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
      const shape = manifest.trackShapes.find((entry) => entry.piece === piece.id);
      if (!shape) throw new Error(`track piece ${piece.id} has no track shape`);
      const { outline: shipped, ...measured } = shape;
      expect(measured).toEqual({
        piece: piece.id,
        footprints: Array.from(headingFootprints(positions, piece.partFrame.headingHalfSteps)),
        hull: Array.from(planHull(positions, piece.partFrame.headingHalfSteps)),
        minY,
        maxY,
      });
      const turned = pieceFrameOutline(outline, piece.partFrame).filter(
        (ring) => !isOnOneLine(ring),
      );
      expect(shipped.map(twiceArea)).toEqual(turned.map(twiceArea));
      expect(shipped.map((ring, r) => keepsOrderOf(ring, turned[r] ?? []))).toEqual(
        shipped.map(() => true),
      );
    }
  });

  it(
    "hand the editor every catalog part's and model's plan glyph, which decodePlanGlyph reads, as the same files at every level of detail",
    async () => {
      const manifest = manifestOf(lod);
      const loaded = new Map<string, boolean | string>();
      for (const part of manifest.catalogParts) {
        loaded.set(part.id, decodedGlyph((await loader.loadPartShape(lod, part)).glyph));
      }
      for (const entry of manifest.models) {
        loaded.set(
          entry.name,
          decodedGlyph((await loader.loadModelRecord(lod, entry.name)).model.glyph),
        );
      }
      expect([...loaded].filter(([, ok]) => ok !== true)).toEqual([]);
      expect(glyphFiles(manifest)).toEqual(glyphFiles(manifestOf("standard")));
    },
    BUNDLE_SWEEP_TIMEOUT_MS,
  );

  it("ship no outline with a repeated point, a spike or a ring of fewer than three points", async () => {
    const shipped = await shippedOutlines((file) => fetcher.text(`${lod}/${file}`));
    expect(shipped.length).toBeGreaterThan(0);
    expect(
      shipped.flatMap(([where, outline]) =>
        degenerateProblems(outline).map((problem) => `${where}: ${problem}`),
      ),
    ).toEqual([]);
  });
});

describe("the fixture bundle's records", () => {
  it("ship no outline with a repeated point, a spike or a ring of fewer than three points", async () => {
    const shipped = await shippedOutlines((file) =>
      readFile(new URL(file, fixtureBundleRoot), "utf8"),
    );
    expect(shipped.length).toBeGreaterThan(0);
    expect(
      shipped.flatMap(([where, outline]) =>
        degenerateProblems(outline).map((problem) => `${where}: ${problem}`),
      ),
    ).toEqual([]);
  });
});
