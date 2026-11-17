import { parseGlb, readPartMesh } from "@brr/catalog/glb";
import { headingFootprints, verticalRange } from "@brr/domain/heading-footprints";
import {
  BundleCredit,
  BundleModelEntry,
  ManifestPart,
  TrackCatalog,
  type CatalogPart,
  type PartExtras,
  type PartRole,
  type PartShape,
  type TrackShape,
  type TrackSilhouette,
} from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";
import { MANIFEST_FILE } from "./publish.ts";
import { trackPlans, type PlanMesh } from "./track-silhouette.ts";

export const PART_TABLE_FILE = "parts.json";
export const CREDIT_TABLE_FILE = "credits.json";

const CATALOG_PART_ROLES: ReadonlySet<PartRole> = new Set(["ground", "road", "track"]);
const TABLE_KEYS: ReadonlySet<string> = new Set(["parts", "credits"]);
const UNSAFE_FILE_CHARACTERS = /[^A-Za-z0-9_-]/gu;

const CompiledTables = v.object({
  parts: v.array(ManifestPart),
  credits: v.array(BundleCredit),
  models: v.array(BundleModelEntry),
  trackCatalog: TrackCatalog,
});

const RawModelFile = v.object({ parts: v.array(v.string()) });

export function shapeFileName(partId: string): string {
  return `shape-${partId.replace(UNSAFE_FILE_CHARACTERS, "_")}.json`;
}

function arrayBuffer(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function partShape(
  part: ManifestPart,
  { studs, technic }: Pick<PartExtras, "studs" | "technic">,
): PartShape {
  return {
    id: part.id,
    title: part.title,
    role: part.role,
    file: part.file,
    bounds: part.bounds,
    baseplate: part.baseplate,
    studs,
    ...(part.displayColor ? { displayColor: part.displayColor } : {}),
    ...(part.producedColors ? { producedColors: part.producedColors } : {}),
    ...(part.trackEnds ? { trackEnds: part.trackEnds } : {}),
    ...(technic ? { technic } : {}),
  };
}

export function silhouetteFileName(pieceId: string): string {
  return `silhouette-${pieceId.replace(UNSAFE_FILE_CHARACTERS, "_")}.json`;
}

function trackShape(
  piece: string,
  positions: Float32Array,
  headingHalfSteps: number,
): Omit<TrackShape, "silhouette"> {
  const [minY, maxY] = verticalRange(positions);
  return {
    piece,
    footprints: Array.from(headingFootprints(positions, headingHalfSteps)),
    minY,
    maxY,
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value));
}

export async function attachRecords(directory: string): Promise<void> {
  const manifestPath = join(directory, MANIFEST_FILE);
  const compiled: Record<string, unknown> = JSON.parse(await readFile(manifestPath, "utf8"));
  const { parts, credits, models, trackCatalog } = decodedOrThrow(
    decode(CompiledTables, compiled),
    manifestPath,
  );
  const shapes = new Map<string, PartShape>();
  const trackMeshes = new Map<string, PlanMesh>();
  for (const part of parts) {
    const glb = parseGlb(arrayBuffer(await readFile(join(directory, part.file))), part.file);
    shapes.set(part.id, partShape(part, glb.document.extras));
    if (part.role === "track") trackMeshes.set(part.id, readPartMesh(glb, part.file));
  }
  const shapeOf = (id: string, where: string): PartShape => {
    const shape = shapes.get(id);
    if (!shape) throw new Error(`${where}: part ${id} is not in the bundle`);
    return shape;
  };
  for (const model of models) {
    const path = join(directory, model.file);
    const raw: Record<string, unknown> = JSON.parse(await readFile(path, "utf8"));
    const { parts: ids } = decodedOrThrow(decode(RawModelFile, raw), model.file);
    await writeJson(path, { ...raw, shapes: ids.map((id) => shapeOf(id, model.file)) });
  }
  const catalogParts: CatalogPart[] = [];
  const shapeFiles = new Set<string>();
  for (const part of parts) {
    if (!CATALOG_PART_ROLES.has(part.role)) continue;
    const file = shapeFileName(part.id);
    if (shapeFiles.has(file)) throw new Error(`two catalog parts share the shape file ${file}`);
    shapeFiles.add(file);
    await writeJson(join(directory, file), shapeOf(part.id, file));
    catalogParts.push({ ...part, shape: { file } });
  }
  const trackShapes: TrackShape[] = [];
  const silhouetteFiles = new Set<string>();
  for (const piece of trackCatalog.pieces) {
    const mesh = trackMeshes.get(piece.part);
    if (!mesh)
      throw new Error(`track piece ${piece.id} names ${piece.part}, not a bundled track part`);
    const { headingHalfSteps } = piece.partFrame;
    const file = silhouetteFileName(piece.id);
    if (silhouetteFiles.has(file)) throw new Error(`two track pieces share the file ${file}`);
    silhouetteFiles.add(file);
    const silhouette: TrackSilhouette = {
      piece: piece.id,
      ...trackPlans(
        mesh,
        piece.partFrame,
        piece.connectors.map((connector) => connector.pose),
      ),
    };
    await writeJson(join(directory, file), silhouette);
    trackShapes.push({
      ...trackShape(piece.id, mesh.positions, headingHalfSteps),
      silhouette: { file },
    });
  }
  await writeJson(join(directory, PART_TABLE_FILE), { parts });
  await writeJson(join(directory, CREDIT_TABLE_FILE), { credits });
  const rest = Object.fromEntries(Object.entries(compiled).filter(([key]) => !TABLE_KEYS.has(key)));
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        ...rest,
        catalogParts,
        trackShapes,
        partTable: { file: PART_TABLE_FILE },
        creditTable: { file: CREDIT_TABLE_FILE },
      },
      null,
      2,
    )}\n`,
  );
}
