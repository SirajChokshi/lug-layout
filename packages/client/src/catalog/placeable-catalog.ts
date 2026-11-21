import {
  BUNDLE_BASE_URL,
  PART_BUNDLE_LOADER,
  undrawnPart,
  type IPartBundleLoader,
  type ModelRecord,
  type PartAsset,
  type PartConnectors,
  type PartModel,
  type PartShapeAsset,
  type PartShapeRecord,
} from "@brr/catalog";
import type { PlacementTarget } from "@brr/domain";
import type {
  CompiledSource,
  ImportReport,
  ImportResult,
  PlacedImport,
  PlacementListener,
  RefusedConnectorRecord,
  StudioReport,
} from "@brr/import";
import { STUD_LDU } from "@brr/math";
import { SCENE_BACKEND, type ChunkInstances, type ISceneBackend, type WorldBox } from "@brr/render";
import type {
  BundleColor,
  BundleIndex,
  BundleLod,
  BundleModelEntry,
  NotDrawnSection,
} from "@brr/schema/bundle";
import { importRef, type ImportedFile } from "@brr/schema/world";
import { inject, injectable } from "inversify";
import { MergedParts } from "../edit/merged-parts.ts";
import { NO_MESHES, type MeshCounts, type MeshProgress } from "../edit/mesh-progress.ts";
import { PartMeshStream } from "../edit/part-mesh-stream.ts";
import {
  modelPlaceable,
  partPlaceable,
  type Placeable,
  type PlacementModel,
} from "../edit/placeable.ts";
import {
  diagnosedPart,
  type DiagnosedPart,
  type RollingDiagnosticsView,
} from "../inspect/rolling-diagnostics.ts";
import type { IModelImporter } from "../import/worker-model-importer.ts";
import { playModel, type PlayModel } from "../play/play-models.ts";
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

export type CheckedStuds =
  | (ImportReports & { readonly kind: "checked"; readonly placeable: Placeable })
  | {
      readonly kind: "failed";
      readonly failure: string;
      readonly report: ImportReport | null;
      readonly studio: StudioReport | null;
    };

export type ImportOutcome =
  | (ImportReports & {
      readonly kind: "placeable";
      readonly item: CatalogItemView;
      readonly credit: ModelCredit;
    })
  | {
      readonly kind: "checking";
      readonly item: CatalogItemView;
      readonly credit: ModelCredit;
      readonly pending: Placeable;
      readonly checked: Promise<CheckedStuds>;
    }
  | (ImportReports & { readonly kind: "refused"; readonly refusal: string });

export type PartConnectorRecord =
  | { readonly kind: "record"; readonly connectors: PartConnectors }
  | { readonly kind: "missing"; readonly reason: string };

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
  rollingDiagnostics(itemId: string): Promise<RollingDiagnosticsView | null>;
  playModel(placeable: Placeable): PlayModel | null;
  notDrawn(placeable: Placeable): ReadonlyArray<NotDrawnSection>;
  baked(placeable: Placeable): Pick<PartModel, "lattice" | "cells"> | null;
  partConnectorRecord(placeableId: string, partIndex: number): Promise<PartConnectorRecord>;
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

const FAR_LOD: BundleLod = "far";
const NO_LATTICE_REASON = "no stud lattice from the bake";
const STUDIO_FILE = /\.io$/iu;
const IMPORTED_SOURCE = "imported file";
const NOT_IN_BUNDLE_RECORDS = "the bundle's connector packages don't list it";
const NOT_IN_IMPORT_RECORDS = "the import found no connector record for it";

interface AddedPlaceable {
  readonly placeable: Placeable;
  readonly model: PlacementModel;
  readonly credit: ModelCredit;
  readonly slot: CatalogSlot;
}

type PlacedSource = Pick<
  PlacedImport,
  | "sections"
  | "bake"
  | "instanceCount"
  | "partIndex"
  | "ldrawColor"
  | "matrices"
  | "partTransforms"
  | "submodels"
>;

function placedModel(placed: PlacedSource): PlacementModel {
  return {
    sections: placed.sections,
    lattice: placed.bake.lattice,
    studCover: null,
    cells: placed.bake.cells,
    instanceCount: placed.instanceCount,
    partIndex: Uint16Array.from(placed.partIndex),
    ldrawColor: placed.ldrawColor,
    matrices: placed.matrices,
    partTransforms: placed.partTransforms,
    submodels: placed.submodels,
    vehicles: placed.bake.vehicles,
  };
}

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
    undrawnParts: [],
  };
  private slots: CatalogSlot[] = [];
  private placeablesByRefId: Array<Placeable | null> = [];
  private readonly loads = new Map<number, Promise<Placeable>>();
  private readonly modelNames = new Map<Placeable, string>();
  private readonly notDrawnSections = new Map<Placeable, ReadonlyArray<NotDrawnSection>>();
  private readonly playModels = new Map<Placeable, PlayModel>();
  private readonly bakes = new Map<Placeable, Pick<PartModel, "lattice" | "cells">>();
  private readonly compiledSources = new Map<string, CompiledSource>();
  private readonly farModelIndex = new Map<string, number>();
  private readonly importRecords = new Map<string, ReadonlyMap<string, PartConnectorRecord>>();
  private readonly broughtRecords = new Map<string, PartConnectors>();
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
    const palette = new MergedParts(shapes.map(undrawnPart));
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
    const parts = record.parts.map(undrawnPart);
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
    if (model.vehicles.length > 0) {
      const identity = { name: entry.name, label: modelLabel(entry), sha256: entry.sha256 };
      this.playModels.set(placeable, playModel(identity, model, { parts }, palette, colors));
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

  private importedResult(file: ImportedFile, onPlaced: PlacementListener): Promise<ImportResult> {
    if (STUDIO_FILE.test(file.name)) {
      return this.importer.importStudio(file.name, file.bytes.slice(), this.lod, onPlaced);
    }
    const text = new TextDecoder().decode(file.bytes);
    return this.importer.importText(file.name, text, this.lod, onPlaced);
  }

  async rollingDiagnostics(itemId: string): Promise<RollingDiagnosticsView | null> {
    const refId = this.itemRefId(itemId);
    if (refId === null) return null;
    const placeable = await this.load(refId);
    const parts = this.requirePalette().parts;
    const diagnosed: DiagnosedPart[] = [];
    for (const index of new Set(placeable.parts.partIndex)) {
      const part = parts[index];
      const served = part?.rolling?.unread ?? [];
      if (part === undefined || served.length === 0) continue;
      const source = this.compiledSources.get(part.id) ?? "bundle";
      diagnosed.push({ partId: part.id, title: part.title, source, served });
    }
    diagnosed.sort((a, b) => (a.partId < b.partId ? -1 : a.partId > b.partId ? 1 : 0));
    const fromBake = diagnosed.filter((part) => part.source === "library-bake");
    const [bundle, bake] = await Promise.all([
      diagnosed.some((part) => part.source === "bundle")
        ? this.loader.loadRollingDiagnostics(this.lod)
        : Promise.resolve(null),
      fromBake.length > 0
        ? this.importer.rollingDiagnostics(
            fromBake.map((part) => part.partId),
            this.lod,
          )
        : Promise.resolve({}),
    ]);
    return { item: itemId, parts: diagnosed.map((part) => diagnosedPart(part, bundle, bake)) };
  }

  async addImported(file: ImportedFile): Promise<ImportOutcome> {
    let announce: PlacementListener | null = null;
    const placement = new Promise<PlacedImport>((resolve) => {
      announce = resolve;
    });
    const imported = this.importedResult(file, (placed) => announce?.(placed));
    const first = await Promise.race([placement, imported.then(() => null)]);
    if (first === null || first.bake.lattice === null || first.bake.cells === null) {
      return this.completeImport(file, await imported);
    }
    this.keepImportedRecords(file, first, first.refusedConnectorRecords);
    const added = await this.addPlaceable(file, placedModel(first), first);
    return {
      kind: "checking",
      item: added.slot.view,
      credit: added.credit,
      pending: added.placeable,
      checked: imported.then(
        (result) => this.checkStuds(added.placeable, added.model, result),
        (error: unknown) => ({
          kind: "failed",
          failure: error instanceof Error ? error.message : String(error),
          report: null,
          studio: null,
        }),
      ),
    };
  }

  private async completeImport(file: ImportedFile, result: ImportResult): Promise<ImportOutcome> {
    this.keepImportedRecords(file, result, result.report.refusedConnectorRecords);
    const reports = { report: result.report, studio: result.studio ?? null };
    const { bake } = result;
    if (!bake || bake.lattice === null || bake.cells === null) {
      const refusal = result.report.bakeIssue ?? bake?.latticeIssue ?? NO_LATTICE_REASON;
      return { ...reports, kind: "refused", refusal };
    }
    const placed = { ...result, sections: result.report.sections, bake };
    const model: PartModel = { ...placedModel(placed), studCover: bake.studCover };
    const added = await this.addPlaceable(file, model, result);
    return { ...reports, kind: "placeable", item: added.slot.view, credit: added.credit };
  }

  private async addPlaceable(
    file: ImportedFile,
    model: PlacementModel,
    parts: Pick<ImportResult, "partIds" | "compiled">,
  ): Promise<AddedPlaceable> {
    const set = await this.loader.loadPartSet(this.lod, parts.partIds, parts.compiled);
    for (const { partId, source } of parts.compiled) this.compiledSources.set(partId, source);
    const palette = this.requirePalette();
    const before = palette.parts.length;
    const remapped = palette.remap(model, set.parts);
    const credit = {
      name: file.name,
      source: `${IMPORTED_SOURCE} ${file.name}`,
      sections: model.sections,
    };
    for (let index = before; index < palette.parts.length; index++) this.meshes?.provide(index);
    const placeable = this.importedPlaceable(importRef(file.sha256), file.name, remapped, credit);
    if (model.vehicles.length > 0) {
      const identity = { name: file.name, label: file.name, sha256: file.sha256 };
      this.playModels.set(placeable, playModel(identity, model, set, palette, this.colors()));
    }
    this.installMerged(palette, before);
    this.bakes.set(placeable, remapped);
    this.placeablesByRefId.push(placeable);
    const slot = placeableSlot(placeable, this.bundleColors, new Map(), undefined);
    this.slots.push(slot);
    return { placeable, model: remapped, credit, slot };
  }

  private importedPlaceable(
    id: string,
    name: string,
    model: PlacementModel,
    credit: ModelCredit,
  ): Placeable {
    const palette = this.requirePalette();
    return modelPlaceable(id, name, name, model, credit, palette.parts, this.colors(), null);
  }

  private checkStuds(
    pending: Placeable,
    model: PlacementModel,
    result: ImportResult,
  ): CheckedStuds {
    const reports = { report: result.report, studio: result.studio ?? null };
    const { bake } = result;
    if (!bake) {
      return { ...reports, kind: "failed", failure: result.report.bakeIssue ?? NO_LATTICE_REASON };
    }
    const refId = this.placeablesByRefId.indexOf(pending);
    const { credit } = pending;
    if (refId < 0 || credit === null) {
      throw new Error(`${pending.label} left the catalog before its studs were checked`);
    }
    const covered = { ...model, studCover: bake.studCover };
    const checked = this.importedPlaceable(pending.id, pending.label, covered, credit);
    this.placeablesByRefId[refId] = checked;
    this.bakes.delete(pending);
    this.bakes.set(checked, model);
    const train = this.playModels.get(pending);
    if (train) {
      this.playModels.delete(pending);
      this.playModels.set(checked, train);
    }
    return { ...reports, kind: "checked", placeable: checked };
  }

  private keepImportedRecords(
    file: ImportedFile,
    imported: Pick<ImportResult, "partIds" | "connectors">,
    refusedRecords: ReadonlyArray<RefusedConnectorRecord>,
  ): void {
    const refused = new Map(refusedRecords.map(({ partId, reason }) => [partId, reason]));
    const own = new Map<string, PartConnectorRecord>();
    imported.partIds.forEach((partId, index) => {
      const connectors = imported.connectors[index] ?? null;
      if (connectors === null) {
        own.set(partId, { kind: "missing", reason: refused.get(partId) ?? NOT_IN_IMPORT_RECORDS });
        return;
      }
      own.set(partId, { kind: "record", connectors });
      if (!this.broughtRecords.has(partId)) this.broughtRecords.set(partId, connectors);
    });
    this.importRecords.set(importRef(file.sha256), own);
  }

  async partConnectorRecord(placeableId: string, partIndex: number): Promise<PartConnectorRecord> {
    const part = this.parts()[partIndex];
    if (!part) throw new Error(`no catalog part has index ${partIndex}`);
    const own = this.importRecords.get(placeableId)?.get(part.id);
    if (own) return own;
    const loaded = await this.loader.readPartConnectors(this.lod, part.id);
    if (loaded.kind === "loaded") return { kind: "record", connectors: loaded.connectors };
    const brought = this.broughtRecords.get(part.id);
    if (brought) return { kind: "record", connectors: brought };
    switch (loaded.kind) {
      case "unlisted":
        return { kind: "missing", reason: NOT_IN_BUNDLE_RECORDS };
      case "refused":
        return { kind: "missing", reason: loaded.reason };
      default: {
        const unhandled: never = loaded;
        throw new Error(`unhandled connector load ${String(unhandled)}`);
      }
    }
  }

  playModel(placeable: Placeable): PlayModel | null {
    return this.playModels.get(placeable) ?? null;
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
