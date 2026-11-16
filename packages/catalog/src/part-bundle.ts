export type BundleLod = "standard" | "low";
export type PartRole = "ground" | "road" | "track" | "wall" | "roof" | "detail";
export type Vec3Tuple = readonly [number, number, number];

export interface MeshArrays {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
}

export interface LdrawAttribution {
  readonly file: string;
  readonly title: string;
  readonly author: string;
  readonly license: string;
  readonly note: string;
}

export interface PartAsset {
  readonly id: string;
  readonly role: PartRole;
  readonly title: string;
  readonly attribution: LdrawAttribution;
  readonly boundsMin: Vec3Tuple;
  readonly boundsMax: Vec3Tuple;
  readonly body: MeshArrays;
  readonly studPrimitiveNames: ReadonlyArray<string>;
  readonly studPrimitiveIndex: Uint8Array;
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

export interface PartBundle {
  readonly lod: BundleLod;
  readonly parts: ReadonlyArray<PartAsset>;
  readonly studPrimitives: ReadonlyArray<StudPrimitiveAsset>;
  readonly colors: ReadonlyArray<BundleColor>;
  readonly credits: ReadonlyArray<BundleCredit>;
  readonly disclaimer: string;
}

export interface IPartBundleLoader {
  load(lod: BundleLod): Promise<PartBundle>;
}

export interface IAssetFetcher {
  bytes(path: string): Promise<ArrayBuffer>;
  text(path: string): Promise<string>;
}
