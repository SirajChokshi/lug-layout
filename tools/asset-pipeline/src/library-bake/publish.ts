import { LibraryBakeBucket, LibraryBakeIndex, type LibraryBakePin } from "@brr/schema/bundle";
import { extname } from "node:path";
import {
  decodeJsonFile,
  type IndexListing,
  type Publication,
} from "../publication/pinned-publication.ts";
import { LIBRARY_BAKE_INDEX } from "./assemble.ts";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".json": "application/json",
  ".bin": "application/octet-stream",
  ".glb": "model/gltf-binary",
};

function listed(file: string, bytes: Uint8Array): IndexListing {
  if (file === LIBRARY_BAKE_INDEX) {
    const index = decodeJsonFile(LibraryBakeIndex, bytes, file);
    return { indexes: index.buckets.map((bucket) => ({ file: bucket })), leaves: [] };
  }
  const bucket = decodeJsonFile(LibraryBakeBucket, bytes, file);
  return {
    indexes: [],
    leaves: Object.values(bucket.parts).flatMap((part) => [part.record, part.glb]),
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
