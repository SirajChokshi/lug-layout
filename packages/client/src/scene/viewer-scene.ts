import type { BundleLod, ModelSection, PartBundle } from "@brr/catalog";
import {
  COLOR_CHANNELS,
  type BackendInfo,
  type FrameStats,
  type PartPalette,
  type SceneBackendConfig,
} from "@brr/render";

export interface SceneSummary {
  readonly parts: number;
  readonly modules: number;
  readonly studInstances: number;
  readonly bodyTriangles: number;
  readonly studTriangles: number;
  readonly creditedFiles: number;
  readonly creditedLicenses: ReadonlyArray<string>;
  readonly modelSections: ReadonlyArray<ModelSection>;
}

export interface InstanceList {
  readonly count: number;
  readonly partIndex: Uint16Array;
}

export interface IViewerScene {
  attach(config: SceneBackendConfig): Promise<BackendInfo>;
  load(lod: BundleLod): Promise<SceneSummary>;
  setCamera(t: number): void;
  resize(width: number, height: number): void;
  renderFrame(out: FrameStats): void;
  waitForGpu(): Promise<void>;
}

export class ColorTable {
  private readonly codes: number[] = [];

  constructor(private readonly bundle: PartBundle) {}

  indexOfCode(code: number): number {
    const existing = this.codes.indexOf(code);
    if (existing >= 0) return existing;
    if (!this.bundle.colors.some((c) => c.code === code)) {
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
      const value = lookup.get(code) ?? 0;
      srgb[i * COLOR_CHANNELS] = (value >> 16) & 0xff;
      srgb[i * COLOR_CHANNELS + 1] = (value >> 8) & 0xff;
      srgb[i * COLOR_CHANNELS + 2] = value & 0xff;
    });
    return srgb;
  }
}

export function ldrawColorsSrgb(bundle: PartBundle): ReadonlyMap<number, number> {
  return new Map(bundle.colors.map((c) => [c.code, Number.parseInt(c.rgb.slice(1), 16)]));
}

export function partPalette(bundle: PartBundle, colors: ColorTable): PartPalette {
  return {
    parts: bundle.parts,
    studPrimitives: bundle.studPrimitives,
    colorsSrgb: colors.toSrgb(),
    ldrawColorsSrgb: ldrawColorsSrgb(bundle),
  };
}

function studTriangles(bundle: PartBundle, partIndex: number): number {
  const part = bundle.parts[partIndex];
  if (!part) return 0;
  let total = 0;
  for (let s = 0; s < part.studPrimitiveIndex.length; s++) {
    total += (bundle.studPrimitives[part.studPrimitiveIndex[s] ?? 0]?.mesh.indices.length ?? 0) / 3;
  }
  return total;
}

export function summarize(
  bundle: PartBundle,
  chunks: ReadonlyArray<InstanceList>,
  modelSections: ReadonlyArray<ModelSection>,
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
  let studTriangleTotal = 0;
  bundle.parts.forEach((part, p) => {
    const count = instances[p] ?? 0;
    let body = 0;
    for (const group of part.mesh.groups) body += group.indices.length / 3;
    const studs = studTriangles(bundle, p);
    parts += count;
    studInstances += count * part.studPrimitiveIndex.length;
    bodyTriangles += count * body;
    studTriangleTotal += count * studs;
  });
  return {
    parts,
    modules: chunks.length,
    studInstances,
    bodyTriangles,
    studTriangles: studTriangleTotal,
    creditedFiles: bundle.credits.length,
    creditedLicenses: [...new Set(bundle.credits.map((c) => c.license ?? "none"))],
    modelSections,
  };
}
