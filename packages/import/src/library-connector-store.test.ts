import {
  partConnectors,
  type ConnectorLoad,
  type PartConnectors,
} from "@brr/catalog/connector-records";
import {
  CONNECTOR_SOURCE,
  contentAddressedFile,
  LIBRARY_CONNECTORS_FORMAT,
  LIBRARY_CONNECTORS_INDEX_FILE,
  type ConnectorRecordFile,
  type LibraryConnectorsIndex,
} from "@brr/schema/bundle";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  BundleThenLibraryConnectors,
  LibraryConnectorStore,
  type LibraryConnectorOptions,
} from "./library-connector-store.ts";
import type { FetchFunction } from "./ldraw-mirror.ts";
import type { IByteCache } from "./verified-files.ts";

const BASE_URL = "https://records.test/library-connectors/";
const HTTP_NOT_FOUND = 404;
const HTTP_UNAVAILABLE = 503;
const SOURCE = { repo: "kulits/ldraw-parts", commit: "c0ffee", root: "ldraw" };
const SHADOW = { kind: "github-archive" as const, repo: "owner/shadow", commit: "5ad0", root: "" };
const VOCABULARY = "a".repeat(64);
const OPTIONS: LibraryConnectorOptions = { source: SOURCE, sectionVocabulary: VOCABULARY };
const CA = "Licensed under CC BY 4.0 : see CAreadme.txt";
const WITH_BOTH = "ldraw:3001";
const CONNECTIVITY_ONLY = "ldraw:3023";
const NEITHER = "ldraw:3069bp01";
const OUTSIDE = "ldraw:not-in-library";

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function record(part: string, source: number, faces: number, vocabulary?: string) {
  const each = <T>(value: T): T[] => Array.from({ length: faces }, () => value);
  return {
    part,
    license: CA,
    ...(vocabulary === undefined ? {} : { sectionVocabulary: vocabulary }),
    faces: {
      gender: each(0 as const),
      source: each(source as ConnectorRecordFile["faces"]["source"][number]),
      status: each(0 as const),
      caps: each(1),
      slide: each(false),
      group: each(""),
      origin: Array.from({ length: faces * 3 }, (_, i) => i * 16),
      axis: each(2),
      sectionStart: Array.from({ length: faces }, (_, i) => i),
      sectionCount: each(1),
      sectionCode: each(0),
      sectionSize: each(6),
      sectionLength: each(4),
      piece: each(1),
    },
    free: { face: [], origin: [], axis: [] },
    unreadable: [],
  } satisfies ConnectorRecordFile;
}

interface Served {
  readonly files: Map<string, Uint8Array>;
  readonly pin: { readonly file: string; readonly sha256: string };
  readonly records: ReadonlyMap<string, ReadonlyArray<ConnectorRecordFile>>;
  readonly recordFile: ReadonlyMap<string, string>;
}

function served(
  change: (index: LibraryConnectorsIndex) => LibraryConnectorsIndex = (index) => index,
): Served {
  const files = new Map<string, Uint8Array>();
  const add = (file: string, value: unknown): string => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const name = contentAddressedFile(file, sha256(bytes));
    files.set(name, bytes);
    return name;
  };
  const tier1 = new Map([
    [WITH_BOTH, record(WITH_BOTH, CONNECTOR_SOURCE.shadow, 2)],
    [CONNECTIVITY_ONLY, record(CONNECTIVITY_ONLY, CONNECTOR_SOURCE.shadow, 1)],
  ]);
  const rest = new Map([[WITH_BOTH, record(WITH_BOTH, CONNECTOR_SOURCE.inferred, 3, VOCABULARY)]]);
  const recordFile = new Map<string, string>();
  const entries = (pkg: string, records: ReadonlyMap<string, ConnectorRecordFile>) =>
    Object.fromEntries(
      [WITH_BOTH, CONNECTIVITY_ONLY, NEITHER].map((id) => {
        const found = records.get(id);
        if (found === undefined) return [id, null];
        const file = add(`${pkg}/${id.slice("ldraw:".length)}.json`, found);
        recordFile.set(`${pkg} ${id}`, file);
        return [id, { file }];
      }),
    );
  const connectivity = add("connectivity-index.json", {
    package: "connectivity",
    licenses: ["CC BY-SA 4.0"],
    attribution: ["LDCad Shadow Library"],
    source: { kind: "github-mirror", repo: SHADOW.repo, commit: SHADOW.commit, root: SHADOW.root },
    parts: entries("connectivity", tier1),
  });
  const connectors = add("connector-index.json", {
    package: "connectors",
    licenses: [CA],
    attribution: [],
    sectionVocabulary: VOCABULARY,
    source: { kind: "github-mirror", ...SOURCE },
    parts: entries("connectors", rest),
  });
  const index = change({
    format: LIBRARY_CONNECTORS_FORMAT,
    ldraw: { kind: "github-mirror", ...SOURCE },
    shadow: SHADOW,
    sectionVocabulary: VOCABULARY,
    connectivity: { file: connectivity },
    connectors: { file: connectors },
  });
  const text = new TextEncoder().encode(JSON.stringify(index));
  files.set(contentAddressedFile(LIBRARY_CONNECTORS_INDEX_FILE, sha256(text)), text);
  const both = [tier1.get(WITH_BOTH), rest.get(WITH_BOTH)].filter((r) => r !== undefined);
  const one = [tier1.get(CONNECTIVITY_ONLY)].filter((r) => r !== undefined);
  return {
    files,
    pin: { file: LIBRARY_CONNECTORS_INDEX_FILE, sha256: sha256(text) },
    records: new Map([
      [WITH_BOTH, both],
      [CONNECTIVITY_ONLY, one],
    ]),
    recordFile,
  };
}

function serving(
  files: ReadonlyMap<string, Uint8Array>,
  requests: string[] = [],
  failing: (file: string) => boolean = () => false,
): FetchFunction {
  return async (url) => {
    requests.push(url);
    const file = url.slice(BASE_URL.length);
    if (failing(file)) return new Response(null, { status: HTTP_UNAVAILABLE });
    const bytes = files.get(file);
    return bytes === undefined
      ? new Response(null, { status: HTTP_NOT_FOUND })
      : new Response(bytes.slice());
  };
}

function memoryCache(): IByteCache & { readonly held: Map<string, Uint8Array> } {
  const held = new Map<string, Uint8Array>();
  return {
    held,
    get: async (key) => held.get(key),
    put: async (key, bytes) => void held.set(key, bytes),
  };
}

function loaded(connectors: PartConnectors): ConnectorLoad {
  return { kind: "loaded", connectors };
}

function reasonOf(load: ConnectorLoad): string {
  return load.kind === "refused" ? load.reason : `not refused: ${load.kind}`;
}

it("reads a listed part's connectivity and connector records, a part listed with neither as no connectors, and serves them again from the cache without fetching", async () => {
  const { files, pin, records } = served();
  const cache = memoryCache();
  const requests: string[] = [];
  const source = new LibraryConnectorStore(BASE_URL, pin, serving(files, requests), cache).source(
    OPTIONS,
  );

  expect(await source.read(WITH_BOTH)).toEqual(
    loaded(partConnectors(records.get(WITH_BOTH) ?? [])),
  );
  expect(await source.read(CONNECTIVITY_ONLY)).toEqual(
    loaded(partConnectors(records.get(CONNECTIVITY_ONLY) ?? [])),
  );
  expect(await source.read(NEITHER)).toEqual(loaded(partConnectors([])));
  expect(await source.read(OUTSIDE)).toEqual({ kind: "unlisted" });

  const again = new LibraryConnectorStore(BASE_URL, pin, serving(files, requests), cache);
  const before = requests.length;
  expect(await again.source(OPTIONS).read(WITH_BOTH)).toEqual(
    loaded(partConnectors(records.get(WITH_BOTH) ?? [])),
  );
  expect(requests.length).toBe(before);
  expect(again.stats()).toMatchObject({ fetched: 0, bytes: 0 });
  expect(again.stats().cached).toBeGreaterThan(0);
});

it("refuses every part, saying why, when the index was computed from another LDraw source or section vocabulary than the import's", async () => {
  const { files, pin } = served();
  const store = () => new LibraryConnectorStore(BASE_URL, pin, serving(files), memoryCache());
  const otherVocabulary = "b".repeat(64);

  expect(
    reasonOf(
      await store()
        .source({ ...OPTIONS, source: { ...SOURCE, commit: "other" } })
        .read(WITH_BOTH),
    ),
  ).toContain(
    `were computed from ${SOURCE.repo}@${SOURCE.commit}/${SOURCE.root}, not the import's ${SOURCE.repo}@other/${SOURCE.root}`,
  );
  expect(
    reasonOf(
      await store()
        .source({ ...OPTIONS, sectionVocabulary: otherVocabulary })
        .read(WITH_BOTH),
    ),
  ).toContain(`section vocabulary ${VOCABULARY}, not ${otherVocabulary}`);
  expect((await store().source(OPTIONS).read(WITH_BOTH)).kind).toBe("loaded");
});

it("refuses every part, rather than failing the import, when the served index differs from its pin or the pinned bytes aren't an index", async () => {
  const { files, pin } = served();
  const indexFile = contentAddressedFile(pin.file, pin.sha256);
  files.set(indexFile, new TextEncoder().encode("{}"));
  const notJson = new TextEncoder().encode("not an index");
  const notJsonPin = { file: LIBRARY_CONNECTORS_INDEX_FILE, sha256: sha256(notJson) };
  files.set(contentAddressedFile(notJsonPin.file, notJsonPin.sha256), notJson);
  const source = (pinned: typeof pin) =>
    new LibraryConnectorStore(BASE_URL, pinned, serving(files), memoryCache()).source(OPTIONS);

  expect(reasonOf(await source(pin).read(WITH_BOTH))).toContain(
    "the served index differs from its pinned SHA-256",
  );
  const unparsable = source(notJsonPin);
  const reads = await Promise.all([unparsable.read(WITH_BOTH), unparsable.read(CONNECTIVITY_ONLY)]);
  expect(reads.map((load) => load.kind)).toEqual(["refused", "refused"]);
});

it("refuses only the part whose record differs from its content address", async () => {
  const { files, pin, recordFile } = served();
  const tampered = recordFile.get(`connectors ${WITH_BOTH}`) ?? "";
  files.set(tampered, new TextEncoder().encode("tampered"));
  const source = new LibraryConnectorStore(BASE_URL, pin, serving(files), memoryCache()).source(
    OPTIONS,
  );

  expect(reasonOf(await source.read(WITH_BOTH))).toContain("differs from its content address");
  expect((await source.read(CONNECTIVITY_ONLY)).kind).toBe("loaded");
});

it("tries a failed index, package index or record download again on the next lookup", async () => {
  const { files, pin, records, recordFile } = served();
  const indexFile = contentAddressedFile(pin.file, pin.sha256);
  const packageIndex =
    [...files.keys()].find((file) => file.startsWith("connectivity-index.")) ?? "";
  const recordPath = recordFile.get(`connectivity ${CONNECTIVITY_ONLY}`) ?? "";
  let failing = (file: string): boolean => file === indexFile;
  const source = new LibraryConnectorStore(
    BASE_URL,
    pin,
    serving(files, [], (file) => failing(file)),
    memoryCache(),
  ).source(OPTIONS);

  const indexDown = await source.read(CONNECTIVITY_ONLY);
  failing = (file) => file === packageIndex;
  const packageIndexDown = await source.read(CONNECTIVITY_ONLY);
  failing = (file) => file === recordPath;
  const recordDown = await source.read(CONNECTIVITY_ONLY);
  failing = () => false;
  const recovered = await source.read(CONNECTIVITY_ONLY);

  expect(reasonOf(indexDown)).toContain(`${indexFile} failed with ${HTTP_UNAVAILABLE}`);
  expect(reasonOf(packageIndexDown)).toContain(`${packageIndex} failed with ${HTTP_UNAVAILABLE}`);
  expect(reasonOf(recordDown)).toContain(`${recordPath} failed with ${HTTP_UNAVAILABLE}`);
  expect(recovered).toEqual(loaded(partConnectors(records.get(CONNECTIVITY_ONLY) ?? [])));
});

it("takes a part's bundle record whenever the bundle lists or refuses it, and the library's only when the bundle doesn't list it", async () => {
  const bundleTable = partConnectors([record(WITH_BOTH, CONNECTOR_SOURCE.shadow, 1)]);
  const libraryTable = partConnectors([record(WITH_BOTH, CONNECTOR_SOURCE.shadow, 2)]);
  const bundleLoads = new Map<string, ConnectorLoad>([
    ["ldraw:bundled", loaded(bundleTable)],
    ["ldraw:refused", { kind: "refused", reason: "bundle refusal" }],
  ]);
  const layered = new BundleThenLibraryConnectors(
    { read: async (partId) => bundleLoads.get(partId) ?? { kind: "unlisted" } },
    { read: async () => loaded(libraryTable) },
  );

  expect(await layered.read("ldraw:bundled")).toEqual(loaded(bundleTable));
  expect(await layered.read("ldraw:refused")).toEqual({
    kind: "refused",
    reason: "bundle refusal",
  });
  expect(await layered.read("ldraw:library")).toEqual(loaded(libraryTable));
});
