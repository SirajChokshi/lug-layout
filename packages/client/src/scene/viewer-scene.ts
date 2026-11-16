import {
  directColorSrgb,
  isDirectColor,
  type BundleLod,
  type ModelSection,
  type PartBundle,
  type PartFilter,
} from "@brr/catalog";
import {
  COLOR_CHANNELS,
  type ChunkInstances,
  type ISceneBackend,
  type PartPalette,
} from "@brr/render";

export const PALETTE_PARTS: PartFilter = (part) => part.role !== "model";

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

  indexOfName(name: string): number {
    const entry = this.bundle.colors.find((c) => c.name === name);
    if (!entry) throw new Error(`LDConfig colour ${name} is missing from the bundle`);
    return this.indexOfCode(entry.code);
  }

  toSrgb(): Uint8Array {
    const lookup = ldrawColorsSrgb(this.bundle);
    const srgb = new Uint8Array(this.codes.length * COLOR_CHANNELS);
    this.codes.forEach((code, i) => {
      const value = isDirectColor(code) ? directColorSrgb(code) : (lookup.get(code) ?? 0);
      srgb[i * COLOR_CHANNELS] = (value >> 16) & 0xff;
      srgb[i * COLOR_CHANNELS + 1] = (value >> 8) & 0xff;
      srgb[i * COLOR_CHANNELS + 2] = value & 0xff;
    });
    return srgb;
  }
}

export function ldrawColorsSrgb(bundle: PartBundle): ReadonlyMap<number, number> {
  const colors = new Map(bundle.colors.map((c) => [c.code, Number.parseInt(c.rgb.slice(1), 16)]));
  for (const part of bundle.parts) {
    for (const group of part.mesh.groups) {
      if (isDirectColor(group.ldrawColor)) {
        colors.set(group.ldrawColor, directColorSrgb(group.ldrawColor));
      }
    }
  }
  return colors;
}

function partPalette(
  bundle: PartBundle,
  far: PartBundle | undefined,
  colors: ColorTable,
): PartPalette {
  return {
    detailed: { parts: bundle.parts, studPrimitives: bundle.studPrimitives },
    ...(far ? { far: { parts: far.parts, studPrimitives: far.studPrimitives } } : {}),
    colorsSrgb: colors.toSrgb(),
    ldrawColorsSrgb: ldrawColorsSrgb(bundle),
  };
}

function summarize(
  bundle: PartBundle,
  chunks: ReadonlyArray<InstanceList>,
  studs: ReadonlyArray<StudList>,
  model: ModelCredit | null,
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
): SceneSummary {
  backend.setPalette(partPalette(bundle, far, colors));
  for (const chunk of chunks) backend.setChunk(chunk.key, chunk.instances);
  const instances = chunks.map((chunk) => chunk.instances);
  return summarize(
    bundle,
    instances,
    instances.map((chunk) => chunk.studs),
    model,
  );
}
