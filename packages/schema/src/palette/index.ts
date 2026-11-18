import * as v from "valibot";

export const PALETTE_MEMORY_VERSION = 1;

export const PaletteMemory = v.strictObject({
  version: v.literal(PALETTE_MEMORY_VERSION),
  favorites: v.array(v.string()),
  recents: v.array(v.string()),
});
export type PaletteMemory = v.InferOutput<typeof PaletteMemory>;
