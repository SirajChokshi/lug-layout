import {
  ConnectorIndexFile,
  LibraryConnectorsIndex,
  type ConnectorPackage,
  type LibraryConnectorsPin,
} from "@brr/schema/bundle";
import type { ObjectReader } from "../library/ldraw-library.ts";
import {
  decodeJsonFile,
  publicationIndexKey,
  uploadPublication,
  verifyServedPublication,
  type IndexListing,
  type Publication,
  type ServedScope,
} from "../publication/pinned-publication.ts";
import type { ObjectStore } from "../r2.ts";
import type { UploadResult } from "../remote-bundle.ts";
import { LIBRARY_CONNECTORS_INDEX } from "./assemble.ts";

export const LIBRARY_CONNECTORS_PREFIX = "library-connectors";
const PACKAGES: ReadonlyArray<ConnectorPackage> = ["connectivity", "connectors"];

export type LibraryConnectorsScope = ServedScope;

function listed(file: string, bytes: Uint8Array, pin: LibraryConnectorsPin): IndexListing {
  if (file === LIBRARY_CONNECTORS_INDEX) {
    const top = decodeJsonFile(LibraryConnectorsIndex, bytes, file);
    return {
      indexes: PACKAGES.map((pkg) => ({ file: top[pkg].file, leaves: pin.records[pkg] })),
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
  prefix: LIBRARY_CONNECTORS_PREFIX,
  indexFile: LIBRARY_CONNECTORS_INDEX,
  leafNoun: "records",
  rebuildCommand: "library-connectors --check",
  pinnedIndex: (pin) => pin.index,
  list: listed,
  contentType: () => "application/json",
};

export function libraryConnectorsIndexKey(pin: LibraryConnectorsPin): string {
  return publicationIndexKey(libraryConnectorsPublication, pin);
}

export function uploadLibraryConnectors(
  store: ObjectStore,
  root: string,
  pin: LibraryConnectorsPin,
): Promise<UploadResult> {
  return uploadPublication(libraryConnectorsPublication, store, root, pin);
}

export function verifyServedLibraryConnectors(
  read: ObjectReader,
  pin: LibraryConnectorsPin,
  scope: LibraryConnectorsScope,
): Promise<string[]> {
  return verifyServedPublication(libraryConnectorsPublication, read, pin, scope);
}
