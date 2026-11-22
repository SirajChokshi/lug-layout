import {
  LIBRARY_BAKE_BUCKETS,
  LibraryBakeBucket,
  LibraryBakeIndex,
  LibraryBakePart,
  libraryBakeBucket,
  type LibraryBakePin,
} from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { liveBundleLibraryBakeIndexes } from "../pointer/live-bundles.ts";
import { partBundlePointer } from "../pointer/part-bundle-pointer.ts";
import {
  movePointer,
  publicationIndexKey,
  pruneUnreferenced,
  uploadPublication,
} from "../publication/pinned-publication.ts";
import { contentAddressedName } from "../publish.ts";
import type { ObjectStore, PrunableStore, StoredObject } from "../r2.ts";
import { assembleLibraryBake, LIBRARY_BAKE_INDEX, LIBRARY_BAKE_PIN } from "./assemble.ts";
import { libraryBakePointer, libraryBakePublication } from "./publish.ts";

const CA = "Licensed under CC BY 4.0 : see CAreadme.txt";
const NOT_CA = "Redistributable under CCAL version 2.0 : see CAreadme.txt but not quite";
const SOURCE = {
  kind: "github-mirror",
  repo: "kulits/ldraw-parts",
  commit: "c0ffee",
  root: "ldraw",
} as const;
const OPTIONS = {
  studPrimitives: ["stud.dat"],
  unofficialAllowlist: [],
  primitives: { source: SOURCE, license: CA, primitives: [] },
};

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

interface Listed {
  readonly id: string;
  readonly record?: string;
  readonly unread?: ReadonlyArray<unknown>;
  readonly rows?: ReadonlyArray<unknown>;
  readonly licenses?: ReadonlyArray<string>;
  readonly failed?: string;
}

const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const ORIGIN = { min: [0, 0, 0], max: [0, 0, 0] };

function glbBytes(stem: string, unread: ReadonlyArray<unknown> | undefined): Buffer {
  const document = {
    asset: { version: "2.0", generator: "brick-compile" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: `parts/${stem}.dat` }],
    meshes: [{ name: `parts/${stem}.dat`, primitives: [] }],
    accessors: [],
    bufferViews: [],
    buffers: [{ byteLength: 0 }],
    extras: {
      unit: "LDU",
      upAxis: "+Y",
      ldraw: {
        file: `parts/${stem}.dat`,
        name: `${stem}.dat`,
        title: stem,
        author: "James Jessiman",
        license: CA,
        ldrawOrg: null,
        note: "modified from LDraw",
      },
      sources: [],
      studs: [],
      bounds: ORIGIN,
      ...(unread === undefined ? {} : { rolling: { stepsPerLdu: 16, surfaces: [], unread } }),
    },
  };
  const text = JSON.stringify(document);
  const json = Buffer.from(text.padEnd(Math.ceil(text.length / 4) * 4, " "));
  const header = Buffer.alloc(12);
  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(GLB_VERSION, 4);
  header.writeUInt32LE(12 + 8 + json.length + 8, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(json.length, 0);
  jsonHeader.writeUInt32LE(CHUNK_JSON, 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(0, 0);
  binHeader.writeUInt32LE(CHUNK_BIN, 4);
  return Buffer.concat([header, jsonHeader, json, binHeader]);
}

const ARC_RAW = {
  from: { numerator: "-31", denominator: "2" },
  to: { numerator: "-13", denominator: "1" },
};
const ARC_ROWS = [
  { reason: "arcs", axis: 1, at: [0, 0], from: -248, to: -208, raw: ARC_RAW },
  { reason: "unoriented", raw: ARC_RAW },
];
const ARC_BANDS = [{ reason: "arcs", axis: 1 }, { reason: "unoriented" }];

async function build(
  shards: ReadonlyArray<ReadonlyArray<Listed>>,
): Promise<{ build: string; out: string }> {
  const root = await mkdtemp(join(tmpdir(), "library-bake-"));
  roots.push(root);
  const directory = join(root, "build");
  await mkdir(join(directory, "records"), { recursive: true });
  await mkdir(join(directory, "standard"), { recursive: true });
  for (const [shard, parts] of shards.entries()) {
    const listing = parts.map((listed) => {
      const stem = listed.id.slice("ldraw:".length);
      if (listed.failed !== undefined)
        return { id: listed.id, part: `${stem}.dat`, failed: listed.failed };
      return {
        id: listed.id,
        part: `${stem}.dat`,
        record: `records/${stem}.bin`,
        glb: `standard/${stem}.glb`,
        licenses: listed.licenses ?? [CA],
        ...(listed.rows === undefined ? {} : { rollingDiagnostics: listed.rows }),
      };
    });
    for (const listed of parts) {
      if (listed.failed !== undefined) continue;
      const stem = listed.id.slice("ldraw:".length);
      await writeFile(join(directory, "records", `${stem}.bin`), listed.record ?? `record ${stem}`);
      await writeFile(join(directory, "standard", `${stem}.glb`), glbBytes(stem, listed.unread));
    }
    await writeFile(
      join(directory, `shard-${shard}-of-${shards.length}.json`),
      JSON.stringify(listing),
    );
  }
  return { build: directory, out: join(root, "out") };
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readIndex(out: string): Promise<LibraryBakeIndex> {
  const raw: unknown = JSON.parse(await readFile(join(out, LIBRARY_BAKE_INDEX), "utf8"));
  return decodedOrThrow(decode(LibraryBakeIndex, raw), LIBRARY_BAKE_INDEX);
}

it("files every part under its own bucket with content-addressed records and GLBs", async () => {
  const ids = ["ldraw:3001", "ldraw:3040b", "ldraw:3626c", "ldraw:60581"];
  const inputs = await build([
    ids.slice(0, 2).map((id) => ({ id })),
    ids.slice(2).map((id) => ({ id })),
  ]);
  const pin = await assembleLibraryBake({ ...inputs, source: SOURCE, options: OPTIONS });
  const indexText = await readFile(join(inputs.out, LIBRARY_BAKE_INDEX), "utf8");
  expect(pin).toEqual({
    index: { file: LIBRARY_BAKE_INDEX, sha256: sha256(indexText) },
    parts: ids.length,
    records: ids.length,
    failed: 0,
  });
  expect(
    await readFile(
      join(inputs.out, contentAddressedName(LIBRARY_BAKE_INDEX, pin.index.sha256)),
      "utf8",
    ),
  ).toBe(indexText);
  const index = await readIndex(inputs.out);
  expect(index.buckets).toHaveLength(LIBRARY_BAKE_BUCKETS);
  expect(index.licenses).toEqual([CA]);
  const filed = new Map<string, { record: string; glb: string }>();
  for (const [bucket, file] of index.buckets.entries()) {
    const bytes = await readFile(join(inputs.out, file));
    expect(file).toContain(sha256(bytes).slice(0, 16));
    const listed = decodedOrThrow(
      decode(LibraryBakeBucket, JSON.parse(bytes.toString("utf8"))),
      file,
    );
    expect(listed.bucket).toBe(bucket);
    for (const [id, part] of Object.entries(listed.parts)) {
      expect(libraryBakeBucket(id)).toBe(bucket);
      filed.set(id, part);
    }
  }
  expect([...filed.keys()].toSorted()).toEqual(ids);
  for (const [id, part] of filed) {
    const stem = id.slice("ldraw:".length);
    for (const [file, content] of [
      [part.record, Buffer.from(`record ${stem}`)],
      [part.glb, glbBytes(stem, undefined)],
    ] as const) {
      expect(await readFile(join(inputs.out, file))).toEqual(content);
      expect(file).toContain(sha256(content).slice(0, 16));
    }
  }
});

it("lists failures and ships no file for them, and files a part whatever licences its sources name", async () => {
  const inputs = await build([
    [
      { id: "ldraw:3001" },
      {
        id: "ldraw:93606dyf",
        failed: "unresolved reference 6177973fc01.dat in parts/93606dyf.dat",
      },
      { id: "ldraw:9999", licenses: [CA, NOT_CA] },
    ],
  ]);
  const pin = await assembleLibraryBake({ ...inputs, source: SOURCE, options: OPTIONS });
  expect(pin.records).toBe(2);
  expect(pin.failed).toBe(1);
  const index = await readIndex(inputs.out);
  expect(index.failed).toEqual({
    "ldraw:93606dyf": "unresolved reference 6177973fc01.dat in parts/93606dyf.dat",
  });
  expect(index.licenses).toEqual([CA, NOT_CA].toSorted());
  const shipped = JSON.stringify(
    await Promise.all(index.buckets.map((file) => readFile(join(inputs.out, file), "utf8"))),
  );
  expect(shipped).toContain("ldraw:9999");
  expect(shipped).not.toContain("93606dyf");
});

it("files each bucket's rolling diagnostics rows in its own content-addressed file, which the bucket names with its SHA-256", async () => {
  const withRows = ["ldraw:3941p01", "ldraw:6143"];
  const inputs = await build([
    [{ id: "ldraw:3001" }, ...withRows.map((id) => ({ id, unread: ARC_BANDS, rows: ARC_ROWS }))],
  ]);
  const pin = await assembleLibraryBake({ ...inputs, source: SOURCE, options: OPTIONS });
  const index = await readIndex(inputs.out);
  const filed = new Map<string, unknown>();
  for (const file of index.buckets) {
    const bucket = decodedOrThrow(
      decode(LibraryBakeBucket, JSON.parse(await readFile(join(inputs.out, file), "utf8"))),
      file,
    );
    const hasRows = Object.keys(bucket.parts).some((id) => withRows.includes(id));
    expect(bucket.rollingDiagnostics !== undefined).toBe(hasRows);
    if (bucket.rollingDiagnostics === undefined) continue;
    const bytes = await readFile(join(inputs.out, bucket.rollingDiagnostics.file));
    expect(bucket.rollingDiagnostics.sha256).toBe(sha256(bytes));
    expect(bucket.rollingDiagnostics.file).toContain(sha256(bytes).slice(0, 16));
    for (const [id, rows] of Object.entries(JSON.parse(bytes.toString("utf8")).parts)) {
      expect(libraryBakeBucket(id)).toBe(bucket.bucket);
      filed.set(id, rows);
    }
  }
  expect(pin.records).toBe(3);
  expect(new Map([...filed].toSorted())).toEqual(new Map(withRows.map((id) => [id, ARC_ROWS])));
});

it.each([
  [
    "rows in another order than its GLB's bands",
    { unread: ARC_BANDS, rows: ARC_ROWS.toReversed() },
  ],
  ["a row fewer than its GLB's bands", { unread: ARC_BANDS, rows: ARC_ROWS.slice(1) }],
  ["bands in its GLB with no rows", { unread: ARC_BANDS }],
  ["rows for bands its GLB doesn't serve", { rows: ARC_ROWS }],
])("refuses a part with %s", async (_case, listed) => {
  const inputs = await build([[{ id: "ldraw:3941p01", ...listed }]]);
  await expect(
    assembleLibraryBake({ ...inputs, source: SOURCE, options: OPTIONS }),
  ).rejects.toThrow("ldraw:3941p01: its rolling diagnostics rows don't match");
});

it("refuses a part that two shards both list", async () => {
  const inputs = await build([[{ id: "ldraw:3001" }], [{ id: "ldraw:3001", record: "other" }]]);
  await expect(
    assembleLibraryBake({ ...inputs, source: SOURCE, options: OPTIONS }),
  ).rejects.toThrow("ldraw:3001 is listed by more than one shard");
});

it("assembles the same pin from the same shards", async () => {
  const shards = [[{ id: "ldraw:3001" }, { id: "ldraw:3002" }], [{ id: "ldraw:3003" }]];
  const first = await assembleLibraryBake({
    ...(await build(shards)),
    source: SOURCE,
    options: OPTIONS,
  });
  const second = await assembleLibraryBake({
    ...(await build(shards)),
    source: SOURCE,
    options: OPTIONS,
  });
  expect(second).toEqual(first);
});

class RecordingStore implements ObjectStore {
  readonly types = new Map<string, string | undefined>();

  async has(): Promise<boolean> {
    return false;
  }

  async put(
    key: string,
    _body: Uint8Array,
    headers: Readonly<Record<string, string>>,
  ): Promise<void> {
    this.types.set(key, headers["Content-Type"]);
  }
}

async function filesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)));
}

async function filesBesideIndex(out: string, pin: LibraryBakePin): Promise<string[]> {
  const pinnedIndex = contentAddressedName(LIBRARY_BAKE_INDEX, pin.index.sha256);
  return (await filesUnder(out)).filter(
    (file) => file !== LIBRARY_BAKE_INDEX && file !== pinnedIndex,
  );
}

const PUBLISHED_TYPES: Readonly<Record<string, string>> = {
  records: "application/octet-stream",
  standard: "model/gltf-binary",
  buckets: "application/json",
  "rolling-diagnostics": "application/json",
};

it("publishes every file the assembly wrote under library-bake/, records as bytes and GLBs as glTF, with the pinned index under its pinned hash", async () => {
  const inputs = await build([
    [{ id: "ldraw:3001" }, { id: "ldraw:3040b", unread: ARC_BANDS, rows: ARC_ROWS }],
    [{ id: "ldraw:3626c" }],
  ]);
  const pin = await assembleLibraryBake({ ...inputs, source: SOURCE, options: OPTIONS });
  const store = new RecordingStore();

  await uploadPublication(libraryBakePublication, store, inputs.out, pin);

  const indexKey = `library-bake/library-bake.${pin.index.sha256.slice(0, 16)}.json`;
  expect(publicationIndexKey(libraryBakePublication, pin)).toBe(indexKey);
  const addressed = await filesBesideIndex(inputs.out, pin);
  const expected = new Map<string, string | undefined>([
    ...addressed.map((file): [string, string | undefined] => [
      `library-bake/${file}`,
      PUBLISHED_TYPES[file.split("/")[0] ?? ""],
    ]),
    [indexKey, "application/json"],
  ]);
  expect(new Map([...store.types].toSorted())).toEqual(new Map([...expected].toSorted()));
});

it("routes the CLI's served command to the committed pin's index under library-bake/", async () => {
  const toolRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const committed = JSON.parse(
    await readFile(join(toolRoot, "..", "..", LIBRARY_BAKE_PIN), "utf8"),
  ) as LibraryBakePin;
  const requested: string[] = [];
  const server = createServer((request, response) => {
    requested.push(`${request.method} ${request.url}`);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["src/library-bake/cli.ts", "served"],
      {
        cwd: toolRoot,
        env: {
          ...process.env,
          PART_BUNDLE_BASE_URL: `http://127.0.0.1:${port}/`,
          GITHUB_OUTPUT: "",
        },
      },
    );
    const indexPath = `/library-bake/library-bake.${committed.index.sha256.slice(0, 16)}.json`;
    expect(requested).toEqual([`HEAD ${indexPath}`]);
    expect(stdout).toBe(`http://127.0.0.1:${port}${indexPath}: served\n`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

it("the library-bake pointer's manifest references its index, every bucket, and every record, GLB and rolling diagnostics file", async () => {
  const inputs = await build([
    [{ id: "ldraw:3001" }, { id: "ldraw:3040b", unread: ARC_BANDS, rows: ARC_ROWS }],
    [{ id: "ldraw:3626c", unread: ARC_BANDS, rows: ARC_ROWS }],
  ]);
  const pin = await assembleLibraryBake({ ...inputs, source: SOURCE, options: OPTIONS });
  const read = async (key: string) => {
    const file = key.slice("library-bake/".length);
    const name =
      file === contentAddressedName(LIBRARY_BAKE_INDEX, pin.index.sha256)
        ? LIBRARY_BAKE_INDEX
        : file;
    return readFile(join(inputs.out, name)).then(
      (bytes) => new Uint8Array(bytes),
      () => undefined,
    );
  };

  const { indexes, files: referenced } = await libraryBakePointer.references(pin.index, read);
  const leaves = referenced.map((file) => file.key);

  const files = await filesBesideIndex(inputs.out, pin);
  expect([...indexes, ...leaves].toSorted()).toEqual(
    [
      `library-bake/${contentAddressedName(LIBRARY_BAKE_INDEX, pin.index.sha256)}`,
      ...files.map((file) => `library-bake/${file}`),
    ].toSorted(),
  );
  expect(leaves.every((key) => !key.startsWith("library-bake/buckets/"))).toBe(true);
  expect(leaves.filter((key) => key.startsWith("library-bake/rolling-diagnostics/"))).toHaveLength(
    new Set(["ldraw:3040b", "ldraw:3626c"].map(libraryBakeBucket)).size,
  );
});

class MemoryStore implements PrunableStore {
  readonly objects = new Map<string, Uint8Array>();

  async has(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    this.objects.set(key, body);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    return this.objects.get(key);
  }

  async list(prefix: string): Promise<ReadonlyArray<StoredObject>> {
    return [...this.objects]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, body]) => ({ key, size: body.length }));
  }

  async delete(keys: ReadonlyArray<string>): Promise<void> {
    for (const key of keys) this.objects.delete(key);
  }
}

it("the library-bake prune keeps the index a live bundle manifest names beyond its own current and previous, and refuses while a named index is missing", async () => {
  const store = new MemoryStore();
  const pins: LibraryBakePin[] = [];
  for (const version of ["fallback", "first", "second", "third"]) {
    const inputs = await build([
      [{ id: "ldraw:3001", record: `3001 ${version}` }, { id: "ldraw:3040b" }],
    ]);
    const pin = await assembleLibraryBake({ ...inputs, source: SOURCE, options: OPTIONS });
    await uploadPublication(libraryBakePublication, store, inputs.out, pin);
    pins.push(pin);
  }
  const [fallbackPin, firstPin, secondPin, thirdPin] = pins;
  if (!fallbackPin || !firstPin || !secondPin || !thirdPin) throw new Error("four pins");
  const root = await mkdtemp(join(tmpdir(), "library-bake-live-"));
  roots.push(root);
  const fallbackPath = join(root, "bundle-fallback.json");
  const manifests = {
    fallback: "manifest.0000000000000001.json",
    current: "manifest.0000000000000002.json",
  };
  await writeFile(fallbackPath, JSON.stringify({ manifest_file: manifests.fallback }));
  const nameIndex = async (manifest: string, index: LibraryBakePin["index"]) => {
    for (const lod of ["standard", "low", "far"]) {
      await store.put(
        `${lod}/${manifest}`,
        new TextEncoder().encode(JSON.stringify({ compiler: { libraryBake: index } })),
      );
    }
  };
  await nameIndex(manifests.fallback, fallbackPin.index);
  await nameIndex(manifests.current, thirdPin.index);
  const bundle = partBundlePointer(fallbackPath);
  await store.put(bundle.key, bundle.encode({ current: manifests.current, previous: null }));
  const read = (key: string) => store.get(key);
  const adapter = {
    ...libraryBakePointer,
    retained: () => liveBundleLibraryBakeIndexes(read, fallbackPath),
  };
  for (const pin of [firstPin, secondPin, thirdPin]) await movePointer(adapter, store, pin.index);
  const firstOnly = async () => {
    const { indexes, files } = await adapter.references(firstPin.index, read);
    const kept = new Set<string>();
    for (const pin of [fallbackPin, secondPin, thirdPin]) {
      const live = await adapter.references(pin.index, read);
      for (const key of [...live.indexes, ...live.files.map((file) => file.key)]) kept.add(key);
    }
    return [...indexes, ...files.map((file) => file.key)].filter((key) => !kept.has(key));
  };
  const doomed = await firstOnly();
  expect(doomed.length).toBeGreaterThan(0);

  const outcome = await pruneUnreferenced(adapter, store, false);

  expect(outcome.doomed.map((object) => object.key).toSorted()).toEqual(doomed.toSorted());
  expect((await adapter.references(fallbackPin.index, read)).indexes.length).toBeGreaterThan(0);
  expect((await pruneUnreferenced(adapter, store, false)).deleted).toBe(0);

  await nameIndex(manifests.fallback, firstPin.index);
  const before = [...store.objects.keys()].toSorted();
  await expect(pruneUnreferenced(adapter, store, false)).rejects.toThrow("is not stored");
  expect([...store.objects.keys()].toSorted()).toEqual(before);
});

it("the library-bake index's fields, its buckets' and its parts' are exactly these, so a field naming a file the content-addressed listing can't reach can't land unseen", () => {
  expect({
    index: Object.keys(LibraryBakeIndex.entries),
    bucket: Object.keys(LibraryBakeBucket.entries),
    part: Object.keys(LibraryBakePart.entries),
  }).toEqual({
    index: ["format", "source", "options", "licenses", "buckets", "failed"],
    bucket: ["bucket", "parts", "rollingDiagnostics"],
    part: ["record", "glb"],
  });
});
