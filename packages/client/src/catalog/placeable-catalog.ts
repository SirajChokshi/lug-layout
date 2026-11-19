import {
  BUNDLE_BASE_URL,
  PART_BUNDLE_LOADER,
  withPlaceholderMesh,
  type IPartBundleLoader,
  type ModelRecord,
  type PartAsset,
  type PartModel,
  type PartShapeAsset,
  type PartShapeRecord,
} from "@brr/catalog";
import type { PlacementTarget } from "@brr/domain";
import type { ImportReport, ImportResult, StudioReport } from "@brr/import";
import { STUD_LDU } from "@brr/math";
import { SCENE_BACKEND, type ChunkInstances, type ISceneBackend, type WorldBox } from "@brr/render";
import type {
  BundleColor,
  BundleIndex,
  BundleLod,
  BundleModelEntry,
  ModelRunningGear,
  NotDrawnSection,
} from "@brr/schema/bundle";
import { importRef, type ImportedFile } from "@brr/schema/world";
import { inject, injectable } from "inversify";
import { MergedParts } from "../edit/merged-parts.ts";
import { NO_MESHES, type MeshCounts, type MeshProgress } from "../edit/mesh-progress.ts";
import { PartMeshStream } from "../edit/part-mesh-stream.ts";
import { modelPlaceable, partPlaceable, type Placeable } from "../edit/placeable.ts";
import type { IModelImporter } from "../import/worker-model-importer.ts";
import { playModel, type PlayModel } from "../play/play-models.ts";
import { gearModelSource, type GearModelSource } from "../running-gear/running-gear-inspector.ts";
import { isPlayable } from "../running-gear/running-gear-summary.ts";
import { ColorTable, ldrawColors, type ModelCredit } from "../scene/viewer-scene.ts";
import { MODEL_IMPORTER } from "../tokens.ts";
import { modelLabel, withoutYear } from "./model-label.ts";
import { thumbnailUrls } from "./thumbnail-urls.ts";

export interface CatalogColorView {
  readonly code: number;
  readonly name: string;
  readonly rgb: string;
}

export interface CatalogItemView {
  readonly id: string;
  readonly label: string;
  readonly shortLabel: string;
  readonly group: string;
  readonly groupLabel: string;
  readonly color: CatalogColorView | null;
  readonly kind: Placeable["kind"] | "track";
  readonly parts: number;
  readonly studsWide: number;
  readonly studsDeep: number;
  readonly thumbnail: string | null;
  readonly aliases: ReadonlyArray<string>;
  readonly elements: ReadonlyArray<string>;
  readonly displayColor: boolean;
  readonly draggable: boolean;
  readonly toggleable: boolean;
  readonly listedUnder: string | null;
}

export interface SkippedCatalogModel {
  readonly name: string;
  readonly reason: string;
}

export interface CatalogItemModel {
  readonly model: ChunkInstances;
  readonly box: WorldBox;
}

export interface StartedCatalog {
  readonly items: ReadonlyArray<CatalogItemView>;
  readonly skipped: ReadonlyArray<SkippedCatalogModel>;
  readonly credits: ReadonlyArray<ModelCredit>;
}

interface ImportReports {
  readonly report: ImportReport;
  readonly studio: StudioReport | null;
}

export type ImportOutcome =
  | (ImportReports & { readonly item: CatalogItemView; readonly credit: ModelCredit })
  | (ImportReports & { readonly item: null; readonly refusal: string });

export interface ICatalogAssets {
  meshProgress(): MeshProgress;
  subscribe(listener: () => void): () => void;
  requestMeshes(partIndices: Iterable<number>): void;
  startFarTier(): Promise<void>;
  claimFarModel(placeable: Placeable): Promise<number | null>;
}

export interface IPlaceableCatalog extends ICatalogAssets {
  start(index: BundleIndex): Promise<StartedCatalog>;
  parts(): ReadonlyArray<PartAsset>;
  colors(): ColorTable;
  placeables(): ReadonlyArray<Placeable | null>;
  itemRefId(itemId: string): number | null;
  refs(): ReadonlyArray<string>;
  resolveRef(ref: string, color: number): PlacementTarget | null;
  load(refId: number): Promise<Placeable>;
  itemModel(itemId: string): Promise<CatalogItemModel | null>;
  addImported(file: ImportedFile): Promise<ImportOutcome>;
  playModel(placeable: Placeable): PlayModel | null;
  gearModel(placeable: Placeable): GearModelSource | null;
  notDrawn(placeable: Placeable): ReadonlyArray<NotDrawnSection>;
  baked(placeable: Placeable): Pick<PartModel, "lattice" | "cells"> | null;
}

interface CatalogSlot {
  readonly id: string;
  readonly group: string;
  readonly worldColor: number;
  readonly view: CatalogItemView;
  readonly model: string | null;
  readonly credit: ModelCredit | null;
}

interface SkippedModel extends SkippedCatalogModel {
  readonly credit: ModelCredit;
}

const NOT_YET_DETECTED: ModelRunningGear = {
  vehicles: [],
  vehicleCouplings: [],
  unresolvedRunningGear: [],
  unreadRollingBands: { instance: [], band: [], reason: [] },
};
const FAR_LOD: BundleLod = "far";
const NO_LATTICE_REASON = "no stud lattice from the bake";
const STUDIO_FILE = /\.io$/iu;
const IMPORTED_SOURCE = "imported file";

export function colorOf(colors: ReadonlyArray<BundleColor>, code: number): BundleColor {
  const color = colors.find((c) => c.code === code);
  if (!color) throw new Error(`LDConfig has no colour ${code}`);
  return color;
}

function footprintArea(part: PartShapeAsset): number {
  return (part.boundsMax[0] - part.boundsMin[0]) * (part.boundsMax[2] - part.boundsMin[2]);
}

function studsAcross(min: number, max: number): number {
  return Math.round((max - min) / STUD_LDU);
}

function catalogItem(
  placeable: Placeable,
  colors: ReadonlyArray<BundleColor>,
  thumbnails: ReadonlyMap<string, string>,
  part: PartShapeAsset | undefined,
): CatalogItemView {
  const colored = placeable.kind === "baseplate" || placeable.kind === "road-plate";
  const produced = part?.producedColors;
  const ldrawNumber = placeable.group.replace(/^ldraw:/u, "");
  const studsWide = Math.round((placeable.box.max[0] - placeable.box.min[0]) / STUD_LDU);
  const studsDeep = Math.round((placeable.box.max[2] - placeable.box.min[2]) / STUD_LDU);
  return {
    id: placeable.id,
    label: placeable.label,
    shortLabel: colored
      ? `${placeable.group.replace(/^[a-z]+:/u, "")} ${studsWide}×${studsDeep}`
      : withoutYear(placeable.label),
    group: placeable.group,
    groupLabel: placeable.groupLabel,
    color: colored ? colorOf(colors, placeable.worldColor) : null,
    kind: placeable.kind,
    parts: placeable.parts.count,
    studsWide,
    studsDeep,
    thumbnail: thumbnails.get(placeable.id) ?? null,
    aliases: produced && produced.rebrickable !== ldrawNumber ? [produced.rebrickable] : [],
    elements:
      produced?.colors.find((color) => color.ldraw === placeable.worldColor)?.elements ?? [],
    displayColor: part !== undefined && part.producedColor === placeable.worldColor,
    draggable: true,
    toggleable: false,
    listedUnder: null,
  };
}

function placeableSlot(
  placeable: Placeable,
  colors: ReadonlyArray<BundleColor>,
  thumbnails: ReadonlyMap<string, string>,
  part: PartShapeAsset | undefined,
): CatalogSlot {
  return {
    id: placeable.id,
    group: placeable.group,
    worldColor: placeable.worldColor,
    view: catalogItem(placeable, colors, thumbnails, part),
    model: null,
    credit: placeable.credit,
  };
}

function lazySlot(entry: BundleModelEntry, thumbnails: ReadonlyMap<string, string>): CatalogSlot {
  const id = `${entry.origin}:${entry.name}`;
  const label = modelLabel(entry);
  const aabb = entry.lattice?.aabb;
  return {
    id,
    group: id,
    worldColor: 0,
    view: {
      id,
      label,
      shortLabel: withoutYear(label),
      group: id,
      groupLabel: label,
      color: null,
      kind: "model",
      parts: entry.instances,
      studsWide: aabb ? studsAcross(aabb.min[0], aabb.max[0]) : 0,
      studsDeep: aabb ? studsAcross(aabb.min[2], aabb.max[2]) : 0,
      thumbnail: thumbnails.get(id) ?? null,
      aliases: [],
      elements: [],
      displayColor: false,
      draggable: true,
      toggleable: false,
      listedUnder: null,
    },
    model: entry.name,
    credit: { name: entry.name, source: entry.source, sections: entry.sections },
  };
}

@injectable()
export class PlaceableCatalog implements IPlaceableCatalog {
  private readonly listeners = new Set<() => void>();
  private lod: BundleLod = "standard";
  private bundleColors: ReadonlyArray<BundleColor> = [];
  private palette: MergedParts | null = null;
  private colorTable: ColorTable | null = null;
  private installedColors = 0;
  private meshes: PartMeshStream | null = null;
  private progress: MeshProgress = {
    detailedPartMeshes: NO_MESHES,
    farPartMeshes: NO_MESHES,
    farModelMeshes: NO_MESHES,
  };
  private slots: CatalogSlot[] = [];
  private placeablesByRefId: Array<Placeable | null> = [];
  private readonly loads = new Map<number, Promise<Placeable>>();
  private readonly modelNames = new Map<Placeable, string>();
  private readonly notDrawnSections = new Map<Placeable, ReadonlyArray<NotDrawnSection>>();
  private readonly playModels = new Map<Placeable, PlayModel>();
  private readonly gearModels = new Map<Placeable, GearModelSource>();
  private readonly bakes = new Map<Placeable, Pick<PartModel, "lattice" | "cells">>();
  private readonly farModelIndex = new Map<string, number>();
  private farReady = false;

  constructor(
    @inject(PART_BUNDLE_LOADER) private readonly loader: IPartBundleLoader,
    @inject(SCENE_BACKEND) private readonly backend: ISceneBackend,
    @inject(BUNDLE_BASE_URL) private readonly bundleBaseUrl: string,
    @inject(MODEL_IMPORTER) private readonly importer: IModelImporter,
  ) {}

  async start(index: BundleIndex): Promise<StartedCatalog> {
    this.lod = index.lod;
    this.bundleColors = index.colors;
    const colorSource = { colors: index.colors, parts: [] };
    const colors = new ColorTable(colorSource);
    for (const color of index.colors) colors.indexOfCode(color.code);
    this.colorTable = colors;
    const [studPrimitives, shapes] = await Promise.all([
      this.loader.loadStudPrimitives(index.lod),
      Promise.all(index.catalogParts.map((part) => this.loader.loadPartShape(index.lod, part))),
    ]);
    const palette = new MergedParts(shapes.map(withPlaceholderMesh));
    this.palette = palette;
    this.meshes = new PartMeshStream(this.loader, this.backend, palette, index.lod, (progress) => {
      this.progress = { ...progress, farModelMeshes: this.progress.farModelMeshes };
      this.notify();
    });
    this.backend.setNeededMeshListener(this.meshes);
    for (const shape of shapes) this.meshes.register(palette.indexOf(shape.id), shape.meshFile);
    const skipped = this.buildCatalog(index, shapes);
    this.backend.setPalette({
      detailed: { parts: palette.parts, studPrimitives },
      colorsSrgb: colors.toSrgb(),
      colorsAlpha: colors.toAlpha(),
      ldrawColors: ldrawColors(colorSource),
    });
    this.installedColors = colors.size;
    return {
      items: this.slots.map((slot) => slot.view),
      skipped: skipped.map(({ name, reason }) => ({ name, reason })),
      credits: [
        ...this.slots.flatMap((slot) => (slot.credit ? [slot.credit] : [])),
        ...skipped.map(({ credit }) => credit),
      ],
    };
  }

  private buildCatalog(index: BundleIndex, shapes: ReadonlyArray<PartShapeRecord>): SkippedModel[] {
    const palette = this.requirePalette();
    const colors = this.colors();
    const thumbnails = thumbnailUrls(this.bundleBaseUrl, index.lod, index.thumbnails);
    const shapeById = new Map(shapes.map((shape) => [shape.id, shape]));
    const shapeOf = (id: string): PartShapeRecord => {
      const shape = shapeById.get(id);
      if (!shape) throw new Error(`${id} has no shape in the bundle`);
      return shape;
    };
    const groundParts = index.catalogParts
      .filter((part) => part.role === "ground")
      .map((part) => shapeOf(part.id))
      .toSorted((a, b) => footprintArea(b) - footprintArea(a));
    const roadParts = index.catalogParts
      .filter((part) => part.role === "road")
      .map((part) => shapeOf(part.id));
    const placeables: Array<Placeable | null> = [...groundParts, ...roadParts].flatMap((part) => {
      const produced = part.producedColors?.colors ?? [];
      if (produced.length === 0) {
        throw new Error(`${part.id} has no produced colour in the bundle`);
      }
      return produced.map(({ ldraw: code }) =>
        partPlaceable(
          part,
          palette.indexOf(part.id),
          code,
          colorOf(index.colors, code).name,
          palette.parts,
          colors,
          index.tablePlane.depthBelowTopLdu,
        ),
      );
    });
    const slots: CatalogSlot[] = placeables.flatMap((placeable) =>
      placeable
        ? [placeableSlot(placeable, index.colors, thumbnails, shapeOf(placeable.group))]
        : [],
    );
    const skipped: SkippedModel[] = [];
    for (const entry of index.models) {
      if (entry.lattice === null) {
        skipped.push({
          name: entry.name,
          reason: NO_LATTICE_REASON,
          credit: { name: entry.name, source: entry.source, sections: entry.sections },
        });
        continue;
      }
      placeables.push(null);
      slots.push(lazySlot(entry, thumbnails));
    }
    this.slots = slots;
    this.placeablesByRefId = placeables;
    return skipped;
  }

  meshProgress(): MeshProgress {
    return this.progress;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  parts(): ReadonlyArray<PartAsset> {
    return this.requirePalette().parts;
  }

  colors(): ColorTable {
    if (!this.colorTable) throw new Error("the catalog has no colour table before it starts");
    return this.colorTable;
  }

  private requirePalette(): MergedParts {
    if (!this.palette) throw new Error("the catalog has no palette before it starts");
    return this.palette;
  }

  placeables(): ReadonlyArray<Placeable | null> {
    return this.placeablesByRefId;
  }

  itemRefId(itemId: string): number | null {
    const refId = this.slots.findIndex((slot) => slot.id === itemId);
    return refId < 0 ? null : refId;
  }

  refs(): ReadonlyArray<string> {
    return this.slots.map((slot) => slot.group);
  }

  resolveRef(ref: string, color: number): PlacementTarget | null {
    const refId = this.slots.findIndex((slot) => slot.group === ref && slot.worldColor === color);
    const slot = this.slots[refId];
    return slot ? { refId, colorId: slot.worldColor } : null;
  }

  load(refId: number): Promise<Placeable> {
    const loaded = this.placeablesByRefId[refId];
    if (loaded) return Promise.resolve(loaded);
    const pending = this.loads.get(refId);
    if (pending) return pending;
    const model = this.slots[refId]?.model;
    if (model === undefined || model === null) {
      return Promise.reject(new Error(`no catalog item has ref id ${refId}`));
    }
    const loading = this.loader.loadModelRecord(this.lod, model).then((record) => {
      const placeable = this.placeablesByRefId[refId] ?? this.modelPlaceableFrom(record);
      this.placeablesByRefId[refId] = placeable;
      return placeable;
    });
    this.loads.set(refId, loading);
    loading.then(
      () => this.loads.delete(refId),
      () => this.loads.delete(refId),
    );
    return loading;
  }

  private modelPlaceableFrom(record: ModelRecord): Placeable {
    const palette = this.requirePalette();
    const colors = this.colors();
    const { entry, model } = record;
    const before = palette.parts.length;
    const parts = record.parts.map(withPlaceholderMesh);
    const merged = palette.remap(model, parts);
    for (const part of record.parts) this.meshes?.register(palette.indexOf(part.id), part.meshFile);
    const placeable = modelPlaceable(
      `${entry.origin}:${entry.name}`,
      entry.name,
      modelLabel(entry),
      merged,
      { name: entry.name, source: entry.source, sections: model.sections },
      palette.parts,
      colors,
      null,
    );
    this.gearModels.set(placeable, gearModelSource(entry.name, entry.sha256, model, { parts }));
    if (isPlayable(model.runningGear)) {
      const name = { name: entry.name, label: modelLabel(entry) };
      this.playModels.set(placeable, playModel(name, model, { parts }, palette, colors));
    }
    this.installMerged(palette, before);
    this.notDrawnSections.set(placeable, entry.notDrawn ?? []);
    this.modelNames.set(placeable, entry.name);
    this.bakes.set(placeable, model);
    return placeable;
  }

  private installMerged(palette: MergedParts, before: number): void {
    if (this.palette !== palette || this.installedColors === 0) return;
    this.backend.addParts(palette.parts.slice(before));
    const colors = this.colors();
    if (colors.size === this.installedColors) return;
    this.installedColors = colors.size;
    this.backend.setColors(colors.toSrgb(), colors.toAlpha());
  }

  async itemModel(itemId: string): Promise<CatalogItemModel | null> {
    const refId = this.itemRefId(itemId);
    if (refId === null) return null;
    const placeable = await this.load(refId).catch(() => null);
    if (!placeable) return null;
    await this.meshes?.whenLoaded(new Set(placeable.parts.partIndex));
    const { min, max } = placeable.box;
    return {
      model: { ...placeable.parts, studs: placeable.studs },
      box: { minX: min[0], minY: min[1], minZ: min[2], maxX: max[0], maxY: max[1], maxZ: max[2] },
    };
  }

  private importedResult(file: ImportedFile): Promise<ImportResult> {
    if (STUDIO_FILE.test(file.name)) {
      return this.importer.importStudio(file.name, file.bytes.slice(), this.lod);
    }
    return this.importer.importText(file.name, new TextDecoder().decode(file.bytes), this.lod);
  }

  async addImported(file: ImportedFile): Promise<ImportOutcome> {
    const result = await this.importedResult(file);
    const reports = { report: result.report, studio: result.studio ?? null };
    const { bake } = result;
    if (!bake || bake.lattice === null || bake.cells === null) {
      const refusal = result.report.bakeIssue ?? bake?.latticeIssue ?? NO_LATTICE_REASON;
      return { ...reports, item: null, refusal };
    }
    const set = await this.loader.loadPartSet(this.lod, result.partIds, result.compiled);
    const palette = this.requirePalette();
    const colors = this.colors();
    const before = palette.parts.length;
    const model: PartModel = {
      sections: result.report.sections,
      lattice: bake.lattice,
      studCover: bake.studCover,
      cells: bake.cells,
      instanceCount: result.instanceCount,
      partIndex: Uint16Array.from(result.partIndex),
      ldrawColor: result.ldrawColor,
      matrices: result.matrices,
      partTransforms: result.partTransforms,
      submodels: result.submodels,
      runningGear: NOT_YET_DETECTED,
    };
    const credit = {
      name: file.name,
      source: `${IMPORTED_SOURCE} ${file.name}`,
      sections: result.report.sections,
    };
    const placeable = modelPlaceable(
      importRef(file.sha256),
      file.name,
      file.name,
      palette.remap(model, set.parts),
      credit,
      palette.parts,
      colors,
      null,
    );
    this.installMerged(palette, before);
    this.bakes.set(placeable, model);
    this.gearModels.set(placeable, gearModelSource(file.name, file.sha256, model, set));
    if (isPlayable(model.runningGear)) {
      const name = { name: file.name, label: file.name };
      this.playModels.set(placeable, playModel(name, model, set, palette, colors));
    }
    this.placeablesByRefId.push(placeable);
    const slot = placeableSlot(placeable, this.bundleColors, new Map(), undefined);
    this.slots.push(slot);
    return { ...reports, item: slot.view, credit };
  }

  playModel(placeable: Placeable): PlayModel | null {
    return this.playModels.get(placeable) ?? null;
  }

  gearModel(placeable: Placeable): GearModelSource | null {
    return this.gearModels.get(placeable) ?? null;
  }

  notDrawn(placeable: Placeable): ReadonlyArray<NotDrawnSection> {
    return this.notDrawnSections.get(placeable) ?? [];
  }

  baked(placeable: Placeable): Pick<PartModel, "lattice" | "cells"> | null {
    return this.bakes.get(placeable) ?? null;
  }

  requestMeshes(partIndices: Iterable<number>): void {
    this.meshes?.request(partIndices);
  }

  async startFarTier(): Promise<void> {
    const [studPrimitives, farFiles] = await Promise.all([
      this.loader.loadStudPrimitives(FAR_LOD),
      this.loader.loadPartFiles(FAR_LOD),
    ]);
    this.backend.setFarStuds(studPrimitives);
    this.meshes?.useFarFiles(farFiles);
    this.farReady = true;
  }

  async claimFarModel(placeable: Placeable): Promise<number | null> {
    if (!this.farReady) return null;
    const name = this.modelNames.get(placeable);
    if (name === undefined || this.farModelIndex.has(name)) return null;
    const farModel = this.farModelIndex.size;
    this.farModelIndex.set(name, farModel);
    this.countFarModelMesh("wanted");
    try {
      const mesh = await this.loader.loadFarModelMesh(name, "low");
      if (!mesh) {
        this.countFarModelMesh("absent");
        return null;
      }
      this.backend.setFarModelMesh(farModel, mesh);
      this.countFarModelMesh("loaded");
      return farModel;
    } catch (error) {
      this.countFarModelMesh("failed");
      throw error;
    }
  }

  private countFarModelMesh(count: keyof MeshCounts): void {
    const farModelMeshes = this.progress.farModelMeshes;
    this.progress = {
      ...this.progress,
      farModelMeshes: { ...farModelMeshes, [count]: farModelMeshes[count] + 1 },
    };
    this.notify();
  }
}
