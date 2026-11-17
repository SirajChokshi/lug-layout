import {
  BundleLod,
  type BundleManifest,
  type BundleModelEntry,
  type ModelSection,
  type ModelVehicle,
  type PartRole,
  type TrackEnd,
  type Vec3,
} from "@brr/schema/bundle";

export const BUNDLE_LODS: ReadonlyArray<BundleLod> = BundleLod.options;

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
  readonly trackEnds: ReadonlyArray<TrackEnd> | undefined;
  readonly mesh: PartMesh;
  readonly studPrimitiveIndex: Uint8Array;
  readonly studColors: Uint16Array;
  readonly studMatrices: Float32Array;
}

export interface StudPrimitiveAsset {
  readonly mesh: MeshArrays;
}

export interface PartModelLattice {
  readonly phaseX: number;
  readonly phaseZ: number;
  readonly aabbMin: Vec3;
  readonly aabbMax: Vec3;
}

export interface PartModel {
  readonly sections: ReadonlyArray<ModelSection>;
  readonly lattice: PartModelLattice | null;
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
  "bundleVersion" | "colors" | "credits" | "models" | "trackCatalog"
> & {
  readonly parts: ReadonlyArray<PartAsset>;
  readonly studPrimitives: ReadonlyArray<StudPrimitiveAsset>;
};

export interface FilterablePart {
  readonly id: string;
  readonly role: PartRole;
}

export type PartFilter = (part: FilterablePart) => boolean;

export interface ModelBundle {
  readonly bundle: PartBundle;
  readonly entry: BundleModelEntry;
  readonly model: PartModel;
}

export interface IPartBundleLoader {
  loadManifest(lod: BundleLod): Promise<BundleManifest>;
  load(lod: BundleLod, include: PartFilter): Promise<PartBundle>;
  loadModel(lod: BundleLod, name: string): Promise<ModelBundle>;
}

export interface IAssetFetcher {
  bytes(path: string): Promise<ArrayBuffer>;
  text(path: string): Promise<string>;
}
