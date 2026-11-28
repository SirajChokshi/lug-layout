import { LibraryBakeBucket, LibraryBakeIndex, type LibraryBakePin } from "@brr/schema/bundle";
import { extname } from "node:path";
import {
  decodeJsonFile,
  pinnedIndexPointer,
  type IndexListing,
  type PinnedIndex,
  type PointerAdapter,
  type Publication,
} from "../publication/pinned-publication.ts";
import { referencedNames } from "../publication/referenced-names.ts";
import { LIBRARY_BAKE_INDEX } from "./assemble.ts";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".json": "application/json",
  ".bin": "application/octet-stream",
  ".glb": "model/gltf-binary",
  ".glyph": "application/octet-stream",
};
const LIBRARY_BAKE_FILE_EXTENSIONS: ReadonlySet<string> = new Set(Object.keys(CONTENT_TYPES));

function listed(file: string, bytes: Uint8Array): IndexListing {
  if (file === LIBRARY_BAKE_INDEX) {
    const index = decodeJsonFile(LibraryBakeIndex, bytes, file);
    const buckets = new Set(index.buckets);
    return {
      indexes: index.buckets.map((bucket) => ({ file: bucket })),
      leaves: [...referencedNames(index, LIBRARY_BAKE_FILE_EXTENSIONS)].filter(
        (name) => !buckets.has(name),
      ),
    };
  }
  return {
    indexes: [],
    leaves: [
      ...referencedNames(
        decodeJsonFile(LibraryBakeBucket, bytes, file),
        LIBRARY_BAKE_FILE_EXTENSIONS,
      ),
    ],
  };
}

function contentType(file: string): string {
  const type = CONTENT_TYPES[extname(file)];
  if (type === undefined) throw new Error(`${file} has no content type to publish under`);
  return type;
}

export const libraryBakePublication: Publication<LibraryBakePin> = {
  prefix: "library-bake",
  indexFile: LIBRARY_BAKE_INDEX,
  leafNoun: "files",
  rebuildCommand: "library-bake --check",
  pinnedIndex: (pin) => pin.index,
  list: listed,
  contentType,
};

export const LIBRARY_BAKE_POINTER = "latest.json";

export const libraryBakePointer: PointerAdapter<PinnedIndex> = pinnedIndexPointer(
  libraryBakePublication,
  listed,
  LIBRARY_BAKE_POINTER,
);
