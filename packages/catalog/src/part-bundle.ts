import {
  BundleLod,
  type BundleManifest,
  type BundleModelEntry,
  type BundleSource,
  type ManifestPart,
  type ModelSection,
  type ModelVehicle,
  type PartRole,
  type ProducedColors,
  type TrackEnd,
  type Vec3,
} from "@brr/schema/bundle";

export const BUNDLE_LODS: ReadonlyArray<BundleLod> = BundleLod.options;
export const DEFAULT_BUNDLE_MANIFEST_FILE = "manifest.json";

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

export interface PartAsset {
  readonly id: string;
  readonly title: string;
  readonly role: PartRole;
  readonly boundsMin: Vec3;
  readonly boundsMax: Vec3;
  readonly producedColor: number | undefined;
  readonly producedColors: ProducedColors | undefined;
  readonly trackEnds: ReadonlyArray<TrackEnd> | undefined;
  readonly mesh: PartMesh;
  readonly studPrimitiveIndex: Uint8Array;
  readonly studColors: Uint16Array;
  readonly studMatrices: Float32Array;
}

export interface StudPrimitiveAsset {
  readonly mesh: MeshArrays;
}

export interface ModelVoxels {
  readonly origin: Vec3;
  readonly cellLdu: Vec3;
  readonly dims: Vec3;
  readonly cellIndex: Uint32Array;
  readonly ldrawColor: Uint32Array;
}

export interface ModelFarMesh {
  readonly mesh: PartMesh;
  readonly voxels: ModelVoxels;
}

export interface PartModelLattice {
  readonly phaseX: number;
  readonly phaseZ: number;
  readonly aabbMin: Vec3;
  readonly aabbMax: Vec3;
}

export { EMPTY_COLUMN } from "@brr/schema/bundle";

export interface ModelCells {
  readonly originX: number;
  readonly originZ: number;
  readonly width: number;
  readonly depth: number;
  readonly restY: number;
  readonly footprint: Uint32Array;
  readonly flat: Uint32Array;
  readonly columnBottom: Int16Array;
  readonly columnTop: Int16Array;
}

export interface ModelStudCover {
  readonly studs: number;
  readonly covered: number;
  readonly visibleBits: Uint32Array;
}

export interface PartModel {
  readonly sections: ReadonlyArray<ModelSection>;
  readonly lattice: PartModelLattice | null;
  readonly studCover: ModelStudCover;
  readonly cells: ModelCells | null;
  readonly instanceCount: number;
  readonly partIndex: Uint16Array;
  readonly ldrawColor: Uint16Array;
  readonly matrices: Float32Array;
  readonly vehicles: ReadonlyArray<PartVehicle>;
}

export type PartVehicle = Omit<ModelVehicle, "body" | "bogies"> & {
  readonly body: Uint32Array;
  readonly bogies: ReadonlyArray<
    Omit<ModelVehicle["bogies"][number], "instances"> & { readonly instances: Uint32Array }
  >;
};

export type PartBundle = Pick<
  BundleManifest,
  "bundleVersion" | "colors" | "credits" | "models" | "trackCatalog" | "milsEdgeRules"
> & {
  readonly parts: ReadonlyArray<PartAsset>;
  readonly studPrimitives: ReadonlyArray<StudPrimitiveAsset>;
};

export type FilterablePart = Pick<ManifestPart, "id" | "role" | "displayColor">;

export type PartFilter = (part: FilterablePart) => boolean;

export interface ModelBundle {
  readonly bundle: PartBundle;
  readonly entry: BundleModelEntry;
  readonly model: PartModel;
  readonly farMesh: ModelFarMesh | undefined;
}

export interface ImportContext {
  readonly bundleVersion: string;
  readonly source: BundleSource;
  readonly compilerPath: string;
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
  bytes(path: string): Promise<ArrayBuffer>;
  text(path: string): Promise<string>;
}
