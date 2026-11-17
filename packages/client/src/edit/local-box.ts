import type { Vec3Tuple } from "@brr/catalog";

export interface LocalBox {
  readonly min: Vec3Tuple;
  readonly max: Vec3Tuple;
}

export const BOX_FLOATS = 6;
