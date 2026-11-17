import { BundleSource, DisplayColor, ModelOrigin, ModelRole, PartRole } from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { readFile } from "node:fs/promises";
import * as v from "valibot";

export const PaletteModel = v.strictObject({
  name: v.string(),
  origin: ModelOrigin,
  role: v.optional(ModelRole),
  file: v.string(),
  sha256: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u)),
  source: v.string(),
  retrieved: v.string(),
  set: v.optional(
    v.strictObject({ name: v.string(), year: v.pipe(v.number(), v.integer()), source: v.string() }),
  ),
});
export type PaletteModel = v.InferOutput<typeof PaletteModel>;

export const AuditGroup = v.strictObject({ group: v.string(), parts: v.array(v.string()) });
export type AuditGroup = v.InferOutput<typeof AuditGroup>;

export const Palette = v.strictObject({
  source: BundleSource,
  config: v.array(v.string()),
  studPrimitives: v.array(v.string()),
  unofficialAllowlist: v.array(v.string()),
  parts: v.array(
    v.strictObject({ id: v.string(), role: PartRole, displayColor: v.optional(DisplayColor) }),
  ),
  omrSource: BundleSource,
  models: v.array(PaletteModel),
  audit: v.array(AuditGroup),
  connectivitySource: BundleSource,
});
export type Palette = v.InferOutput<typeof Palette>;

export async function readPalette(path: string): Promise<Palette> {
  return decodedOrThrow(decode(Palette, JSON.parse(await readFile(path, "utf8"))), path);
}
