import {
  directColorSrgb,
  isDirectColor,
  type ModelFarMesh,
  type PartBundle,
  type PartFilter,
} from "@brr/catalog";
import type { BundleLod, ModelSection } from "@brr/schema/bundle";
import {
  COLOR_CHANNELS,
  type ChunkInstances,
  type ISceneBackend,
  type LdrawColor,
  type PartPalette,
} from "@brr/render";

const CATALOG_ROLES: ReadonlySet<string> = new Set(["ground", "road"]);

const hasSceneColor: PartFilter = (part) =>
  !CATALOG_ROLES.has(part.role) || part.displayColor !== undefined;

export const PALETTE_PARTS: PartFilter = (part) => part.role !== "model" && hasSceneColor(part);
const DIRECT_COLOR_ALPHA = 255;

export interface SceneSummary {
  readonly bundleVersion: string;
  readonly parts: number;
  readonly modules: number;
  readonly studInstances: number;
  readonly visibleStudInstances: number;
  readonly bodyTriangles: number;
  readonly studTriangles: number;
  readonly creditedFiles: number;
  readonly model: ModelCredit | null;
  readonly track: TrackSummary | null;
  readonly farModel: FarModelSummary | null;
}

export interface FarModelSummary {
  readonly voxels: number;
  readonly triangles: number;
}

export interface TrackSummary {
  readonly plan: string;
  readonly placements: number;
  readonly ends: number;
  readonly joins: number;
  readonly openEnds: number;
  readonly coincidentNotJoined: number;
  readonly switches: number;
  readonly directedEdges: number;
  readonly reachableFromFirstEdge: number;
  readonly unverifiedPlacements: number;
}

export interface ModelCredit {
  readonly name: string;
  readonly source: string;
  readonly sections: ReadonlyArray<ModelSection>;
}

interface InstanceList {
  readonly count: number;
  readonly partIndex: Uint16Array;
}

interface StudList {
  readonly count: number;
  readonly primitiveIndex: Uint8Array;
}

export interface IViewerScene {
  readonly backend: ISceneBackend;
  load(lod: BundleLod): Promise<SceneSummary>;
  setCamera(t: number): void;
  onFrame?(): void;
}

export class ColorTable {
  private readonly codes: number[] = [];

  constructor(private readonly bundle: PartBundle) {}

  indexOfCode(code: number): number {
    const existing = this.codes.indexOf(code);
    if (existing >= 0) return existing;
    if (!isDirectColor(code) && !this.bundle.colors.some((c) => c.code === code)) {
      throw new Error(`LDraw colour ${code} is not in LDConfig`);
    }
    this.codes.push(code);
    return this.codes.length - 1;
  }

  codeAt(index: number): number {
    const code = this.codes[index];
    if (code === undefined) throw new RangeError(`colour index ${index} is not in the table`);
    return code;
  }

  indexOfName(name: string): number {
    const entry = this.bundle.colors.find((c) => c.name === name);
    if (!entry) throw new Error(`LDConfig colour ${name} is missing from the bundle`);
    return this.indexOfCode(entry.code);
  }

  toSrgb(): Uint8Array {
    const lookup = ldrawColors(this.bundle);
    const srgb = new Uint8Array(this.codes.length * COLOR_CHANNELS);
    this.codes.forEach((code, i) => {
      const value = colorOf(lookup, code).srgb;
      srgb[i * COLOR_CHANNELS] = (value >> 16) & 0xff;
      srgb[i * COLOR_CHANNELS + 1] = (value >> 8) & 0xff;
      srgb[i * COLOR_CHANNELS + 2] = value & 0xff;
    });
    return srgb;
  }

  toAlpha(): Uint8Array {
    const lookup = ldrawColors(this.bundle);
    return Uint8Array.from(this.codes, (code) => colorOf(lookup, code).alpha);
  }
}

function colorOf(lookup: ReadonlyMap<number, LdrawColor>, code: number): LdrawColor {
  if (isDirectColor(code)) return { srgb: directColorSrgb(code), alpha: DIRECT_COLOR_ALPHA };
  const color = lookup.get(code);
  if (color === undefined) throw new Error(`LDraw colour ${code} is not in LDConfig`);
  return color;
}

export function ldrawColors(bundle: PartBundle): ReadonlyMap<number, LdrawColor> {
  const colors = new Map<number, LdrawColor>(
    bundle.colors.map((c) => [
      c.code,
      { srgb: Number.parseInt(c.rgb.slice(1), 16), alpha: c.alpha },
    ]),
  );
  for (const part of bundle.parts) {
    for (const group of part.mesh.groups) {
      if (isDirectColor(group.ldrawColor)) {
        colors.set(group.ldrawColor, {
          srgb: directColorSrgb(group.ldrawColor),
          alpha: DIRECT_COLOR_ALPHA,
        });
      }
    }
  }
  return colors;
}

function partPalette(
  bundle: PartBundle,
  far: PartBundle | undefined,
  farModel: ModelFarMesh | undefined,
  colors: ColorTable,
): PartPalette {
  return {
    detailed: { parts: bundle.parts, studPrimitives: bundle.studPrimitives },
    ...(far ? { far: { parts: far.parts, studPrimitives: far.studPrimitives } } : {}),
    ...(farModel ? { farModels: [farModel.mesh] } : {}),
    colorsSrgb: colors.toSrgb(),
    colorsAlpha: colors.toAlpha(),
    ldrawColors: ldrawColors(bundle),
  };
}

function summarize(
  bundle: PartBundle,
  chunks: ReadonlyArray<InstanceList>,
  studs: ReadonlyArray<StudList>,
  model: ModelCredit | null,
  farModel: ModelFarMesh | undefined,
): SceneSummary {
  const instances = new Float64Array(bundle.parts.length);
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.count; i++) {
      const part = chunk.partIndex[i] ?? 0;
      instances[part] = (instances[part] ?? 0) + 1;
    }
  }
  let parts = 0;
  let studInstances = 0;
  let bodyTriangles = 0;
  bundle.parts.forEach((part, p) => {
    const count = instances[p] ?? 0;
    let body = 0;
    for (const group of part.mesh.groups) body += group.indices.length / 3;
    parts += count;
    studInstances += count * part.studPrimitiveIndex.length;
    bodyTriangles += count * body;
  });
  const primitiveTriangles = bundle.studPrimitives.map(
    (primitive) => primitive.mesh.indices.length / 3,
  );
  let visibleStudInstances = 0;
  let studTriangles = 0;
  for (const list of studs) {
    visibleStudInstances += list.count;
    for (let s = 0; s < list.count; s++) {
      studTriangles += primitiveTriangles[list.primitiveIndex[s] ?? 0] ?? 0;
    }
  }
  return {
    bundleVersion: bundle.bundleVersion,
    parts,
    modules: chunks.length,
    studInstances,
    visibleStudInstances,
    bodyTriangles,
    studTriangles,
    creditedFiles: bundle.credits.length,
    model,
    track: null,
    farModel: farModel
      ? {
          voxels: farModel.voxels.cellIndex.length,
          triangles: farModel.mesh.groups.reduce((sum, g) => sum + g.indices.length / 3, 0),
        }
      : null,
  };
}

export interface KeyedChunk {
  readonly key: number;
  readonly instances: ChunkInstances;
}

export function showChunks(
  backend: ISceneBackend,
  bundle: PartBundle,
  far: PartBundle | undefined,
  colors: ColorTable,
  chunks: ReadonlyArray<KeyedChunk>,
  model: ModelCredit | null,
  farModel?: ModelFarMesh,
): SceneSummary {
  backend.setPalette(partPalette(bundle, far, farModel, colors));
  for (const chunk of chunks) backend.setChunk(chunk.key, chunk.instances);
  const instances = chunks.map((chunk) => chunk.instances);
  return summarize(
    bundle,
    instances,
    instances.map((chunk) => chunk.studs),
    model,
    farModel,
  );
}
