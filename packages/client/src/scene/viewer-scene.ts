import type { BundleLod, PartBundle } from "@brr/catalog";
import {
  COLOR_CHANNELS,
  type BackendInfo,
  type FrameStats,
  type SceneBackendConfig,
} from "@brr/render";
import type { ChunkPlacements } from "./placements.ts";

export interface PartUsage {
  readonly id: string;
  readonly title: string;
  readonly instances: number;
  readonly trianglesPerInstance: number;
}

export interface SceneSummary {
  readonly parts: number;
  readonly modules: number;
  readonly studInstances: number;
  readonly bodyTriangles: number;
  readonly studTriangles: number;
  readonly usage: ReadonlyArray<PartUsage>;
  readonly creditedFiles: number;
  readonly creditedLicenses: ReadonlyArray<string>;
  readonly disclaimer: string;
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
  private readonly names: string[] = [];

  indexOf(name: string): number {
    const existing = this.names.indexOf(name);
    if (existing >= 0) return existing;
    this.names.push(name);
    return this.names.length - 1;
  }

  toSrgb(bundle: PartBundle): Uint8Array {
    const srgb = new Uint8Array(this.names.length * COLOR_CHANNELS);
    this.names.forEach((name, i) => {
      const entry = bundle.colors.find((c) => c.name === name);
      if (!entry) throw new Error(`LDConfig colour ${name} is missing from the bundle`);
      const value = Number.parseInt(entry.rgb.slice(1), 16);
      srgb[i * COLOR_CHANNELS] = (value >> 16) & 0xff;
      srgb[i * COLOR_CHANNELS + 1] = (value >> 8) & 0xff;
      srgb[i * COLOR_CHANNELS + 2] = value & 0xff;
    });
    return srgb;
  }
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
  chunks: ReadonlyArray<ChunkPlacements>,
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
  const usage = bundle.parts.map((part, p): PartUsage => {
    const count = instances[p] ?? 0;
    const body = part.body.indices.length / 3;
    const studs = studTriangles(bundle, p);
    parts += count;
    studInstances += count * part.studPrimitiveIndex.length;
    bodyTriangles += count * body;
    studTriangleTotal += count * studs;
    return { id: part.id, title: part.title, instances: count, trianglesPerInstance: body + studs };
  });
  return {
    parts,
    modules: chunks.length,
    studInstances,
    bodyTriangles,
    studTriangles: studTriangleTotal,
    usage,
    creditedFiles: bundle.credits.length,
    creditedLicenses: [...new Set(bundle.credits.map((c) => c.license ?? "none"))],
    disclaimer: bundle.disclaimer,
  };
}
