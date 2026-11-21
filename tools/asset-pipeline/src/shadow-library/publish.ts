import {
  SHADOW_LIBRARY_INDEX_FILE,
  ShadowLibraryIndex,
  type ShadowLibraryPin,
} from "@brr/schema/bundle";
import { extname } from "node:path";
import {
  decodeJsonFile,
  type IndexListing,
  type Publication,
} from "../publication/pinned-publication.ts";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".json": "application/json",
  ".md": "text/markdown; charset=utf-8",
  ".dat": "text/plain; charset=utf-8",
};

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
  const type = CONTENT_TYPES[extname(file).toLowerCase()];
  if (type === undefined) throw new Error(`${file} has no content type to publish under`);
  return type;
}

export const shadowLibraryPublication: Publication<ShadowLibraryPin> = {
  prefix: "shadow-library",
  indexFile: SHADOW_LIBRARY_INDEX_FILE,
  leafNoun: "files",
  rebuildCommand: "shadow-library --check",
  pinnedIndex: (pin) => pin.index,
  list: listed,
  contentType,
};
