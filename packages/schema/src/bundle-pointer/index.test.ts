import { expect, it } from "vitest";
import { BUNDLE_POINTER_FILE, isContentAddressedPath } from "./index.ts";

it("names the pointer so a cache of content-addressed files never pins it", () => {
  expect(isContentAddressedPath("standard/manifest.3cd92e805bfe8274.json")).toBe(true);
  expect(isContentAddressedPath("far/shape-3001.0123456789abcdef.json")).toBe(true);
  expect(isContentAddressedPath(BUNDLE_POINTER_FILE)).toBe(false);
});
