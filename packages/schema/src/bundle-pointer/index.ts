import * as v from "valibot";

export const BUNDLE_POINTER_FILE = "current.json";
export const BUNDLE_POINTER_CACHE_CONTROL = "public, max-age=60";

export const BundlePointer = v.object({
  manifestFile: v.pipe(v.string(), v.regex(/^manifest\.[0-9a-f]{16}\.json$/u)),
});
export type BundlePointer = v.InferOutput<typeof BundlePointer>;
