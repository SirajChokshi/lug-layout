import {
  PART_BUNDLE_LOADER,
  type IPartBundleLoader,
  type PartAsset,
  type PartBundle,
} from "@brr/catalog";
import { BomCounter, countPlacements, World, type PlacementContents } from "@brr/domain";
import type { BundleCredit, BundleLod } from "@brr/schema/bundle";
import { BASE_LAYER_ID } from "@brr/schema/world";
import type { ImportResult } from "@brr/import";
import { CHUNK_LDU, STUD_LDU, chunkKey, chunkOf } from "@brr/math";
import { INSTANCE_MATRIX_FLOATS, SCENE_BACKEND, type ISceneBackend } from "@brr/render";
import { inject, injectable } from "inversify";
import { sceneRegion, type BomInput, type BomScope, type IBomSource } from "../bom/bom-service.ts";
import type { UncountedItem } from "@brr/domain";
import type { IModelImporter } from "../import/worker-model-importer.ts";
import { MODEL_IMPORTER } from "../tokens.ts";
import { withStuds } from "./stud-stream.ts";
import {
  ColorTable,
  showChunks,
  type IViewerScene,
  type KeyedChunk,
  type SceneSummary,
} from "./viewer-scene.ts";

export interface ModulePlacement {
  readonly module: number;
  readonly x: number;
  readonly z: number;
  readonly yPlates: number;
  readonly rot: number;
}

export interface ImportedModule {
  readonly result: ImportResult;
  readonly placement: ModulePlacement;
  readonly summary: SceneSummary;
  readonly importMs: number;
  readonly sceneMs: number;
}

export interface IImportScene extends IViewerScene, IBomSource {
  importText(fileName: string, text: string): Promise<ImportedModule>;
  importStudio(fileName: string, bytes: Uint8Array): Promise<ImportedModule>;
  placements(): ReadonlyArray<ModulePlacement>;
}

interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

interface PlacedModule {
  readonly result: ImportResult;
  readonly x: number;
  readonly z: number;
  readonly bounds: Bounds;
}

const MODULE_GAP_LDU = 4 * STUD_LDU;
const ORBIT_DISTANCE_FACTOR = 2.8;
const ORBIT_ELEVATION_FACTOR = 0.9;
const MIN_ORBIT_RADIUS_LDU = 200;
const NO_COLOR = 0;
const GROUND_PLATES = 0;
const NO_TURN = 0;
const EMPTY_WORLD_EYE_LDU = { x: 800, y: 600, z: 800 } as const;
const IMPORTED_WORLD_NAME = "imported-world";

function emptyBounds(): Bounds {
  return {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
    minZ: Infinity,
    maxZ: -Infinity,
  };
}

function instanceBounds(result: ImportResult): Bounds {
  const bounds = emptyBounds();
  for (let i = 0; i < result.instanceCount; i++) {
    const o = i * INSTANCE_MATRIX_FLOATS;
    const x = result.matrices[o + 3] ?? 0;
    const y = result.matrices[o + 7] ?? 0;
    const z = result.matrices[o + 11] ?? 0;
    bounds.minX = Math.min(bounds.minX, x);
    bounds.maxX = Math.max(bounds.maxX, x);
    bounds.minY = Math.min(bounds.minY, y);
    bounds.maxY = Math.max(bounds.maxY, y);
    bounds.minZ = Math.min(bounds.minZ, z);
    bounds.maxZ = Math.max(bounds.maxZ, z);
  }
  if (result.instanceCount === 0) return { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
  return bounds;
}

function latticeCeil(ldu: number): number {
  return Math.ceil(ldu / STUD_LDU) * STUD_LDU;
}

function latticeRound(ldu: number): number {
  return Math.round(ldu / STUD_LDU) * STUD_LDU;
}

class ChunkBuilder {
  readonly partIndex: number[] = [];
  readonly colorIndex: number[] = [];
  readonly matrices: number[] = [];

  constructor(
    readonly chunkX: number,
    readonly chunkZ: number,
  ) {}
}

function importUncounted(result: ImportResult, placements: number): UncountedItem[] {
  const source = result.report.fileName;
  const parts = result.report.parts.flatMap((part): UncountedItem[] =>
    part.kind === "bundle" || part.kind === "compiled" || part.kind === "custom"
      ? []
      : [
          {
            source,
            item: part.reference,
            ldrawColor: null,
            quantity: part.instances * placements,
            reason: `import ${part.kind}`,
          },
        ],
  );
  const loose = result.report.looseGeometry.map((geometry): UncountedItem => ({
    source,
    item: geometry.section,
    ldrawColor: null,
    quantity: null,
    reason: `loose geometry outside any part (${geometry.triangles} triangles, ${geometry.quads} quads)`,
  }));
  const colors = result.report.unknownColors.map((issue): UncountedItem => ({
    source,
    item: "instances in an unknown colour",
    ldrawColor: issue.code,
    quantity: issue.instances * placements,
    reason: "colour not in LDConfig; the importer does not draw these instances",
  }));
  return [...parts, ...loose, ...colors];
}

@injectable()
export class ImportScene implements IImportScene {
  private lod: BundleLod = "standard";
  private readonly world = new World();
  private readonly modules: PlacedModule[] = [];
  private readonly partIds: string[] = [];
  private readonly partSlots = new Map<string, number>();
  private readonly parts: PartAsset[] = [];
  private readonly compiledCredits: BundleCredit[] = [];
  private base: PartBundle | undefined;
  private nextX = 0;
  private view = emptyBounds();
  private ldconfigCodes: ReadonlyArray<number> = [];

  constructor(
    @inject(PART_BUNDLE_LOADER) private readonly loader: IPartBundleLoader,
    @inject(MODEL_IMPORTER) private readonly importer: IModelImporter,
    @inject(SCENE_BACKEND) readonly backend: ISceneBackend,
  ) {}

  async load(lod: BundleLod): Promise<SceneSummary> {
    this.lod = lod;
    const bundle = await this.loader.loadPartSet(lod, [], []);
    this.base = bundle;
    this.ldconfigCodes = bundle.colors.map((color) => color.code);
    return showChunks(this.backend, bundle, undefined, new ColorTable(bundle), [], null);
  }

  importText(fileName: string, text: string): Promise<ImportedModule> {
    return this.place(() => this.importer.importText(fileName, text, this.lod));
  }

  importStudio(fileName: string, bytes: Uint8Array): Promise<ImportedModule> {
    return this.place(() => this.importer.importStudio(fileName, bytes, this.lod));
  }

  private async place(load: () => Promise<ImportResult>): Promise<ImportedModule> {
    const started = performance.now();
    const result = await load();
    const imported = performance.now();
    const newIds = result.partIds.filter((id) => !this.partSlots.has(id));
    const added = await this.loader.loadPartSet(this.lod, newIds, result.compiled);
    for (const [index, id] of newIds.entries()) {
      const part = added.parts[index];
      if (!part) throw new Error(`part ${id} did not load`);
      this.partSlots.set(id, this.partIds.length);
      this.partIds.push(id);
      this.parts.push(part);
    }
    const baseCredits = this.base?.credits.length ?? 0;
    this.compiledCredits.push(...added.credits.slice(baseCredits));
    const bounds = instanceBounds(result);
    const x = latticeCeil(this.nextX - bounds.minX);
    const z = latticeRound(-(bounds.minZ + bounds.maxZ) / 2);
    const module = this.modules.length;
    this.world.add(module, NO_COLOR, x, z, GROUND_PLATES, NO_TURN, BASE_LAYER_ID);
    this.modules.push({ result, x, z, bounds });
    this.nextX = x + bounds.maxX + MODULE_GAP_LDU;
    this.frame();
    const base = this.base ?? added;
    const summary = this.show(
      { ...base, parts: this.parts, credits: [...base.credits, ...this.compiledCredits] },
      result,
    );
    return {
      result,
      placement: { module, x, z, yPlates: GROUND_PLATES, rot: NO_TURN },
      summary,
      importMs: imported - started,
      sceneMs: performance.now() - imported,
    };
  }

  placements(): ReadonlyArray<ModulePlacement> {
    const out: ModulePlacement[] = [];
    for (const chunk of this.world.chunks()) {
      for (let i = 0; i < chunk.count; i++) {
        out.push({
          module: chunk.refId[i] ?? 0,
          x: chunk.x[i] ?? 0,
          z: chunk.z[i] ?? 0,
          yPlates: chunk.yPlates[i] ?? 0,
          rot: chunk.rot[i] ?? 0,
        });
      }
    }
    return out.toSorted((a, b) => a.module - b.module);
  }

  bomInput(scope: BomScope): BomInput {
    const counter = new BomCounter(this.partIds, this.ldconfigCodes);
    const placedCounts = new Map<number, number>();
    const contents: PlacementContents = {
      addTo: (target, refId) => {
        const module = this.modules[refId];
        if (!module) throw new Error(`world holds unknown module ${refId}`);
        placedCounts.set(refId, (placedCounts.get(refId) ?? 0) + 1);
        const slots = module.result.partIds.map((id) => this.partSlots.get(id) ?? -1);
        const slotIndex = Uint32Array.from(module.result.partIndex, (local) => slots[local] ?? -1);
        target.addInstances(slotIndex, module.result.ldrawColor, module.result.instanceCount, 1);
      },
    };
    const placements = countPlacements(this.world, contents, counter, sceneRegion(scope));
    const uncounted = [...placedCounts].flatMap(([refId, count]) => {
      const module = this.modules[refId];
      return module ? importUncounted(module.result, count) : [];
    });
    return {
      name: IMPORTED_WORLD_NAME,
      lod: this.lod,
      placements,
      counter,
      uncounted,
      shopping: null,
    };
  }

  private show(bundle: PartBundle, latest: ImportResult): SceneSummary {
    const colors = new ColorTable(bundle);
    const builders = new Map<number, ChunkBuilder>();
    for (const placement of this.placements()) {
      const module = this.modules[placement.module];
      if (!module) throw new Error(`world holds unknown module ${placement.module}`);
      this.expand(module.result, placement, colors, builders);
    }
    const chunks: KeyedChunk[] = [...builders].map(([key, builder]) => ({
      key,
      instances: withStuds(
        {
          originX: builder.chunkX * CHUNK_LDU,
          originZ: builder.chunkZ * CHUNK_LDU,
          count: builder.partIndex.length,
          partIndex: Uint16Array.from(builder.partIndex),
          colorIndex: Uint16Array.from(builder.colorIndex),
          matrices: Float32Array.from(builder.matrices),
        },
        bundle.parts,
        colors,
      ),
    }));
    return showChunks(this.backend, bundle, undefined, colors, chunks, {
      name: latest.report.fileName,
      source: `imported file, parts from LDraw ${latest.report.mirror.repo}@${latest.report.mirror.commit.slice(0, 7)}`,
      sections: latest.report.sections,
    });
  }

  private expand(
    result: ImportResult,
    placement: ModulePlacement,
    colors: ColorTable,
    builders: Map<number, ChunkBuilder>,
  ): void {
    const slots = result.partIds.map((id) => {
      const slot = this.partSlots.get(id);
      if (slot === undefined) throw new Error(`part ${id} has no palette slot`);
      return slot;
    });
    for (let i = 0; i < result.instanceCount; i++) {
      const o = i * INSTANCE_MATRIX_FLOATS;
      const worldX = placement.x + (result.matrices[o + 3] ?? 0);
      const worldZ = placement.z + (result.matrices[o + 11] ?? 0);
      const chunkX = chunkOf(worldX);
      const chunkZ = chunkOf(worldZ);
      const key = chunkKey(chunkX, chunkZ);
      let builder = builders.get(key);
      if (!builder) {
        builder = new ChunkBuilder(chunkX, chunkZ);
        builders.set(key, builder);
      }
      builder.partIndex.push(slots[result.partIndex[i] ?? 0] ?? 0);
      builder.colorIndex.push(colors.indexOfCode(result.ldrawColor[i] ?? 0));
      for (let k = 0; k < INSTANCE_MATRIX_FLOATS; k++) {
        builder.matrices.push(result.matrices[o + k] ?? 0);
      }
      const t = builder.matrices.length - INSTANCE_MATRIX_FLOATS;
      builder.matrices[t + 3] = worldX - chunkX * CHUNK_LDU;
      builder.matrices[t + 11] = worldZ - chunkZ * CHUNK_LDU;
    }
  }

  private frame(): void {
    const view = emptyBounds();
    for (const module of this.modules) {
      view.minX = Math.min(view.minX, module.x + module.bounds.minX);
      view.maxX = Math.max(view.maxX, module.x + module.bounds.maxX);
      view.minY = Math.min(view.minY, module.bounds.minY);
      view.maxY = Math.max(view.maxY, module.bounds.maxY);
      view.minZ = Math.min(view.minZ, module.z + module.bounds.minZ);
      view.maxZ = Math.max(view.maxZ, module.z + module.bounds.maxZ);
    }
    this.view = view;
  }

  setCamera(t: number): void {
    if (this.modules.length === 0) {
      const eye = EMPTY_WORLD_EYE_LDU;
      this.backend.setView(eye.x, eye.y, eye.z, 0, 0, 0);
      return;
    }
    const { minX, maxX, minY, maxY, minZ, maxZ } = this.view;
    const centreX = (minX + maxX) / 2;
    const centreY = (minY + maxY) / 2;
    const centreZ = (minZ + maxZ) / 2;
    const radius = Math.max(
      Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2,
      MIN_ORBIT_RADIUS_LDU,
    );
    const angle = t * 2 * Math.PI;
    const distance = radius * ORBIT_DISTANCE_FACTOR;
    this.backend.setView(
      centreX + distance * Math.cos(angle),
      centreY + radius * ORBIT_ELEVATION_FACTOR,
      centreZ + distance * Math.sin(angle),
      centreX,
      centreY,
      centreZ,
    );
  }
}
