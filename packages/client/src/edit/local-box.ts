import type { Vec3 } from "@brr/schema/bundle";

export interface LocalBox {
  readonly min: Vec3;
  readonly max: Vec3;
}

export const BOX_FLOATS = 6;
