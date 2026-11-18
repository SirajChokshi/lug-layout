import { ShadowLibraryIndex, type ShadowLibraryPin } from "@brr/schema/bundle";
import {
  decodeJsonFile,
  type IndexListing,
  type Publication,
} from "../publication/pinned-publication.ts";
import { SHADOW_LIBRARY_INDEX } from "./assemble.ts";

const LICENSE_TEXT_EXTENSION = ".md";

function listed(file: string, bytes: Uint8Array): IndexListing {
  const index = decodeJsonFile(ShadowLibraryIndex, bytes, file);
  return {
    indexes: [],
    leaves: [
      ...Object.values(index.shadow),
      ...Object.values(index.patches),
      index.patchManifest.file,
      index.licenseText.file,
    ],
  };
}

function contentType(file: string): string {
  if (file.endsWith(".json")) return "application/json";
  if (file.endsWith(LICENSE_TEXT_EXTENSION)) return "text/markdown; charset=utf-8";
  return "text/plain; charset=utf-8";
}

export const shadowLibraryPublication: Publication<ShadowLibraryPin> = {
  prefix: "shadow-library",
  indexFile: SHADOW_LIBRARY_INDEX,
  leafNoun: "files",
  rebuildCommand: "shadow-library --check",
  pinnedIndex: (pin) => pin.index,
  list: listed,
  contentType,
};
