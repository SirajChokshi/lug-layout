import {
  ConnectorIndexFile,
  LIBRARY_CONNECTORS_INDEX_FILE,
  LibraryConnectorsIndex,
  type ConnectorPackage,
  type LibraryConnectorsPin,
} from "@brr/schema/bundle";
import {
  decodeJsonFile,
  pinnedIndexPointer,
  type IndexListing,
  type PinnedIndex,
  type PointerAdapter,
  type Publication,
} from "../publication/pinned-publication.ts";

const PACKAGES: ReadonlyArray<ConnectorPackage> = ["connectivity", "connectors"];

function listed(file: string, bytes: Uint8Array, pin?: LibraryConnectorsPin): IndexListing {
  if (file === LIBRARY_CONNECTORS_INDEX_FILE) {
    const top = decodeJsonFile(LibraryConnectorsIndex, bytes, file);
    return {
      indexes: PACKAGES.map((pkg) => ({
        file: top[pkg].file,
        ...(pin === undefined ? {} : { leaves: pin.records[pkg] }),
      })),
      leaves: [],
    };
  }
  const index = decodeJsonFile(ConnectorIndexFile, bytes, file);
  return {
    indexes: [],
    leaves: Object.values(index.parts).flatMap((entry) => (entry === null ? [] : [entry.file])),
  };
}

export const libraryConnectorsPublication: Publication<LibraryConnectorsPin> = {
  prefix: "library-connectors",
  indexFile: LIBRARY_CONNECTORS_INDEX_FILE,
  leafNoun: "records",
  rebuildCommand: "library-connectors --check",
  pinnedIndex: (pin) => pin.index,
  list: listed,
  contentType: () => "application/json",
};

export const LIBRARY_CONNECTORS_POINTER = "latest.json";

export const libraryConnectorsPointer: PointerAdapter<PinnedIndex> = pinnedIndexPointer(
  libraryConnectorsPublication,
  listed,
  LIBRARY_CONNECTORS_POINTER,
);
