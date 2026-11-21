import * as v from "valibot";

export const OWNED_PARTS_FILE_VERSION = 1;

export const OwnedPartsFile = v.strictObject({
  version: v.literal(OWNED_PARTS_FILE_VERSION),
  name: v.string(),
  text: v.string(),
});
export type OwnedPartsFile = v.InferOutput<typeof OwnedPartsFile>;
