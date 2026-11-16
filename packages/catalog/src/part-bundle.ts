export type BundleLod = "standard" | "low";
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

export interface PartAsset {
  readonly id: string;
  readonly role: PartRole;
  readonly title: string;
  readonly boundsMin: Vec3Tuple;
  readonly boundsMax: Vec3Tuple;
  readonly producedColor: number | undefined;
  readonly mesh: PartMesh;
  readonly studPrimitiveIndex: Uint8Array;
  readonly studColors: Uint16Array;
  readonly studMatrices: Float32Array;
}

export interface StudPrimitiveAsset {
  readonly name: string;
  readonly mesh: MeshArrays;
}

export interface BundleColor {
  readonly code: number;
  readonly name: string;
  readonly rgb: string;
  readonly alpha: number;
}

export interface BundleCredit {
  readonly path: string;
  readonly title: string;
  readonly author: string;
  readonly license: string | null;
}

export interface ModelSection {
  readonly name: string;
  readonly title: string;
  readonly author: string;
  readonly license: string | null;
}

export interface BundleModelEntry {
  readonly name: string;
  readonly file: string;
  readonly sections: ReadonlyArray<ModelSection>;
}

export interface PartModel {
  readonly sections: ReadonlyArray<ModelSection>;
  readonly instanceCount: number;
  readonly partIndex: Uint16Array;
  readonly ldrawColor: Uint16Array;
  readonly matrices: Float32Array;
}

export interface PartBundle {
  readonly lod: BundleLod;
  readonly parts: ReadonlyArray<PartAsset>;
  readonly studPrimitives: ReadonlyArray<StudPrimitiveAsset>;
  readonly colors: ReadonlyArray<BundleColor>;
  readonly credits: ReadonlyArray<BundleCredit>;
  readonly models: ReadonlyArray<BundleModelEntry>;
}

export interface IPartBundleLoader {
  load(lod: BundleLod): Promise<PartBundle>;
  loadModel(lod: BundleLod, entry: BundleModelEntry): Promise<PartModel>;
}

export interface IAssetFetcher {
  bytes(path: string): Promise<ArrayBuffer>;
  text(path: string): Promise<string>;
}
