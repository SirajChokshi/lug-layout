import * as v from "valibot";

export const BUNDLE_POINTER_FILE = "current/latest.json";
export const BUNDLE_POINTER_CACHE_CONTROL = "public, max-age=60";

const CONTENT_ADDRESSED_PATH = /\.[0-9a-f]{16}\.[a-z0-9]+$/u;

export function isContentAddressedPath(path: string): boolean {
  return CONTENT_ADDRESSED_PATH.test(path);
}

export const BundlePointer = v.object({
  manifestFile: v.pipe(v.string(), v.regex(/^manifest\.[0-9a-f]{16}\.json$/u)),
});
export type BundlePointer = v.InferOutput<typeof BundlePointer>;
