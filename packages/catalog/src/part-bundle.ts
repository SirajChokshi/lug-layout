import type {
  ConnectorIndexPaths,
  ConnectorLoad,
  PackageAttribution,
  PartConnectors,
} from "./connector-records.ts";
import {
  BundleLod,
  type BundleIndex,
  type BundleManifest,
  type BundleModelEntry,
  type CatalogPart,
  type BundleSource,
  type CompilerVehicles,
  type LibraryBakeIndexRef,
  type LibraryConnectorsIndexRef,
  type ManifestPart,
  type ModelSection,
  type ModelVehicle,
  type PartRole,
  type PartRolling,
  type PartTechnic,
  type ProducedColors,
  type PrimitiveConnectorTable,
  type SectionVocabulary,
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

export interface PartShapeAsset {
  readonly id: string;
  readonly title: string;
  readonly role: PartRole;
  readonly boundsMin: Vec3;
  readonly boundsMax: Vec3;
  readonly producedColor: number | undefined;
  readonly producedColors: ProducedColors | undefined;
  readonly trackEnds: ReadonlyArray<TrackEnd> | undefined;
  readonly studPrimitiveIndex: Uint8Array;
  readonly studColors: Uint16Array;
  readonly studMatrices: Float32Array;
  readonly technic: PartTechnic | null;
  readonly rolling: PartRolling | null;
}

export interface PartAsset extends PartShapeAsset {
  readonly mesh: PartMesh;
}

export interface PartShapeRecord extends PartShapeAsset {
  readonly meshFile: string;
}

export interface ModelRecord {
  readonly entry: BundleModelEntry;
  readonly model: PartModel;
  readonly parts: ReadonlyArray<PartShapeRecord>;
}

export type FetchPriority = "high" | "low";

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

export interface PartModelSubmodels {
  readonly count: number;
  readonly parent: Int32Array;
  readonly matrices: Float64Array;
  readonly ofPart: Int32Array;
}

export interface PartModel {
  readonly sections: ReadonlyArray<ModelSection>;
  readonly lattice: PartModelLattice | null;
  readonly studCover: ModelStudCover;
  readonly cells: ModelCells | null;
  readonly instanceCount: number;
  readonly partIndex: Uint16Array;
  readonly ldrawColor: Uint32Array;
  readonly matrices: Float32Array;
  readonly partTransforms: Float64Array;
  readonly submodels: PartModelSubmodels;
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
  "bundleVersion" | "colors" | "credits" | "models" | "trackCatalog" | "trackShapes" | "tablePlane"
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

export interface PinnedSectionVocabulary {
  readonly sha256: string;
  readonly vocabulary: SectionVocabulary;
}

export interface ImportContext {
  readonly bundleVersion: string;
  readonly source: BundleSource;
  readonly compilerPath: string;
  readonly connectorIndexes: ConnectorIndexPaths;
  readonly unofficialAllowlist: ReadonlyArray<string>;
  readonly studPrimitiveNames: ReadonlyArray<string>;
  readonly primitives: PrimitiveConnectorTable | null;
  readonly sectionVocabulary: PinnedSectionVocabulary;
  readonly cavityProbe: string;
  readonly partIds: ReadonlyArray<string>;
  readonly ldconfigCodes: ReadonlyArray<number>;
  readonly translucentCodes: ReadonlyArray<number>;
  readonly tableDepthLdu: number;
  readonly vehicles: CompilerVehicles | null;
  readonly libraryBake: LibraryBakeIndexRef | null;
  readonly libraryConnectors: LibraryConnectorsIndexRef | null;
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
  loadManifestFile(): Promise<string>;
  loadIndex(lod: BundleLod): Promise<BundleIndex>;
  loadStudPrimitives(lod: BundleLod): Promise<ReadonlyArray<StudPrimitiveAsset>>;
  loadPartShape(lod: BundleLod, part: CatalogPart): Promise<PartShapeRecord>;
  loadModelRecord(lod: BundleLod, name: string): Promise<ModelRecord>;
  loadPartMesh(lod: BundleLod, file: string, priority: FetchPriority): Promise<PartMesh>;
  setPartMeshPriority(lod: BundleLod, file: string, priority: FetchPriority): void;
  loadFarModelMesh(name: string, priority: FetchPriority): Promise<PartMesh | null>;
  loadPartFiles(lod: BundleLod): Promise<ReadonlyMap<string, string>>;
  loadManifest(lod: BundleLod): Promise<BundleManifest>;
  load(lod: BundleLod, include: PartFilter): Promise<PartBundle>;
  loadModel(lod: BundleLod, name: string): Promise<ModelBundle>;
  importContext(lod: BundleLod): Promise<ImportContext>;
  loadPartConnectors(lod: BundleLod, partId: string): Promise<PartConnectors | null>;
  readPartConnectors(lod: BundleLod, partId: string): Promise<ConnectorLoad>;
  loadConnectivityAttribution(lod: BundleLod): Promise<PackageAttribution>;
  loadSectionVocabularyAttribution(lod: BundleLod): Promise<PackageAttribution | null>;
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
