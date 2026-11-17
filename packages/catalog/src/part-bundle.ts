import type { BundleSource } from "./manifest.ts";
import type { BundleManifest } from "./manifest.ts";
import type { BakedVehicle } from "./model-vehicle.ts";
import type { TrackCatalog } from "./track-catalog.ts";

export type BundleLod = "standard" | "low" | "far";
export const BUNDLE_LODS: ReadonlyArray<BundleLod> = ["standard", "low", "far"];
export type PartRole = "ground" | "road" | "track" | "wall" | "roof" | "detail" | "model";
export type Vec3Tuple = readonly [number, number, number];

export interface MeshArrays {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
}

export const INHERIT_COLOR = 16;

export interface ColorGroup {
  readonly ldrawColor: number;
  readonly indices: Uint32Array;
}

export interface PartMesh {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly groups: ReadonlyArray<ColorGroup>;
}

export interface TrackEnd {
  readonly xStuds: number;
  readonly zStuds: number;
  readonly headingSteps: number;
  readonly fieldCertified: boolean;
  readonly coefficients: ReadonlyArray<string> | null;
}

export interface PartAsset {
  readonly id: string;
  readonly title: string;
  readonly role: PartRole;
  readonly boundsMin: Vec3Tuple;
  readonly boundsMax: Vec3Tuple;
  readonly producedColor: number | undefined;
  readonly trackEnds: ReadonlyArray<TrackEnd> | undefined;
  readonly mesh: PartMesh;
  readonly studPrimitiveIndex: Uint8Array;
  readonly studColors: Uint16Array;
  readonly studMatrices: Float32Array;
}

export interface StudPrimitiveAsset {
  readonly mesh: MeshArrays;
}

export interface BundleColor {
  readonly code: number;
  readonly name: string;
  readonly rgb: string;
}

export interface BundleCredit {
  readonly path: string;
  readonly title: string;
  readonly author: string;
  readonly license: string | null;
}

export interface ModelSection {
  readonly name: string;
  readonly title?: string;
  readonly author: string;
  readonly license: string | null;
}

export type ModelOrigin = "omr" | "generated";
export type ModelRole = "road-module";

export interface ModelSet {
  readonly name: string;
  readonly year: number;
  readonly source: string;
}

export interface BundleModelEntry {
  readonly name: string;
  readonly file: string;
  readonly origin: ModelOrigin;
  readonly set: ModelSet | null;
  readonly role?: ModelRole;
  readonly source: string;
  readonly authors: ReadonlyArray<string>;
  readonly licenses: ReadonlyArray<string>;
  readonly sections: ReadonlyArray<ModelSection>;
  readonly inlinePartsResolvedToOfficial: ReadonlyArray<InlinePartResolution>;
  readonly instances: number;
  readonly notDrawn?: ReadonlyArray<NotDrawnSection>;
}

export interface NotDrawnSection {
  readonly section: string;
  readonly kind: string;
  readonly reason: string;
  readonly instances?: number;
  readonly colors?: ReadonlyArray<{ readonly color: number; readonly instances: number }>;
  readonly triangles?: number;
  readonly quads?: number;
}

export interface InlinePartResolution {
  readonly inline: string;
  readonly official: string;
}

export interface ModelLattice {
  readonly phaseX: number;
  readonly phaseZ: number;
  readonly aabbMin: Vec3Tuple;
  readonly aabbMax: Vec3Tuple;
}

export interface PartModel {
  readonly sections: ReadonlyArray<ModelSection>;
  readonly lattice: ModelLattice | null;
  readonly instanceCount: number;
  readonly partIndex: Uint16Array;
  readonly ldrawColor: Uint16Array;
  readonly matrices: Float32Array;
  readonly vehicles: ReadonlyArray<BakedVehicle>;
}

export interface BundlePartCount {
  readonly part: string;
  readonly ldrawColor: number | null;
  readonly quantity: number;
}

export interface BundleModuleRecipe {
  readonly groundPart: string;
  readonly edgeJoinCells: ReadonlyArray<readonly [number, number]>;
  readonly surfacePlates: number;
  readonly substructure: ReadonlyArray<BundlePartCount>;
}

export interface BundleModuleProfile {
  readonly id: "lego-modular" | "mils";
  readonly moduleStuds: number;
  readonly joinParts: ReadonlyArray<string>;
  readonly joinLevelPlates: number;
  readonly recipe: BundleModuleRecipe | null;
  readonly source: string;
}

export interface BundleModuleStandards {
  readonly groundParts: ReadonlyArray<string>;
  readonly profiles: ReadonlyArray<BundleModuleProfile>;
}

export interface PartBundle {
  readonly bundleVersion: string;
  readonly moduleStandards: BundleModuleStandards;
  readonly parts: ReadonlyArray<PartAsset>;
  readonly studPrimitives: ReadonlyArray<StudPrimitiveAsset>;
  readonly colors: ReadonlyArray<BundleColor>;
  readonly credits: ReadonlyArray<BundleCredit>;
  readonly models: ReadonlyArray<BundleModelEntry>;
  readonly trackCatalog: TrackCatalog;
}

export interface PartSummary {
  readonly id: string;
  readonly role: PartRole;
}

export type PartFilter = (part: PartSummary) => boolean;

export interface ModelBundle {
  readonly bundle: PartBundle;
  readonly entry: BundleModelEntry;
  readonly model: PartModel;
}

export interface ImportContext {
  readonly bundleVersion: string;
  readonly source: BundleSource;
  readonly compilerUrl: string;
  readonly unofficialAllowlist: ReadonlyArray<string>;
  readonly studPrimitiveNames: ReadonlyArray<string>;
  readonly partIds: ReadonlyArray<string>;
  readonly ldconfigCodes: ReadonlyArray<number>;
}

export interface CompiledPartGlb {
  readonly partId: string;
  readonly glb: Uint8Array;
}

export interface CatalogPartComponent {
  readonly part: string;
  readonly color: number;
}

export interface CatalogPartIds {
  readonly rebrickable: string | null;
  readonly bricklink: string | null;
  readonly bricklinkFromKeywordOnly?: boolean;
  readonly components?: ReadonlyArray<CatalogPartComponent>;
}

export interface CatalogColorIds {
  readonly rebrickable: number | null;
  readonly bricklink: number | null;
}

export interface CatalogCrosswalk {
  readonly parts: ReadonlyMap<string, CatalogPartIds>;
  readonly colors: ReadonlyMap<number, CatalogColorIds>;
}

export type BricklinkPartCandidates = Readonly<Record<string, ReadonlyArray<string>>>;

export interface IPartBundleLoader {
  loadManifest(lod: BundleLod): Promise<BundleManifest>;
  load(lod: BundleLod, include: PartFilter): Promise<PartBundle>;
  loadModel(lod: BundleLod, name: string): Promise<ModelBundle>;
  importContext(lod: BundleLod): Promise<ImportContext>;
  loadPartSet(
    lod: BundleLod,
    partIds: ReadonlyArray<string>,
    compiled: ReadonlyArray<CompiledPartGlb>,
  ): Promise<PartBundle>;
  loadCrosswalk(lod: BundleLod): Promise<CatalogCrosswalk>;
  loadBricklinkParts(lod: BundleLod): Promise<BricklinkPartCandidates>;
}

export interface IAssetFetcher {
  url(path: string): string;
  bytes(path: string): Promise<ArrayBuffer>;
  text(path: string): Promise<string>;
}
