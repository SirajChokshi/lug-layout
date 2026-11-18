import {
  LIBRARY_BAKE_BUCKETS,
  LibraryBakeBucket,
  LibraryBakeIndex,
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
import { publicationIndexKey, uploadPublication } from "../publication/pinned-publication.ts";
import { contentAddressedName } from "../publish.ts";
import type { ObjectStore } from "../r2.ts";
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
  readonly glb?: string;
  readonly licenses?: ReadonlyArray<string>;
  readonly failed?: string;
}

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
      };
    });
    for (const listed of parts) {
      if (listed.failed !== undefined) continue;
      const stem = listed.id.slice("ldraw:".length);
      await writeFile(join(directory, "records", `${stem}.bin`), listed.record ?? `record ${stem}`);
      await writeFile(join(directory, "standard", `${stem}.glb`), listed.glb ?? `glb ${stem}`);
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
    refused: [],
  });
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
      [part.record, `record ${stem}`],
      [part.glb, `glb ${stem}`],
    ] as const) {
      expect(await readFile(join(inputs.out, file), "utf8")).toBe(content);
      expect(file).toContain(sha256(content).slice(0, 16));
    }
  }
});

it("lists failures, refuses parts whose sources are not all CA, and ships no file for either", async () => {
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
  expect(pin.records).toBe(1);
  expect(pin.failed).toBe(1);
  expect(pin.refused).toEqual([{ part: "ldraw:9999", licenses: [CA, NOT_CA] }]);
  const index = await readIndex(inputs.out);
  expect(index.failed).toEqual({
    "ldraw:93606dyf": "unresolved reference 6177973fc01.dat in parts/93606dyf.dat",
  });
  const shipped = JSON.stringify(
    await Promise.all(index.buckets.map((file) => readFile(join(inputs.out, file), "utf8"))),
  );
  expect(shipped).not.toContain("9999");
  expect(shipped).not.toContain("93606dyf");
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

const PUBLISHED_TYPES: Readonly<Record<string, string>> = {
  records: "application/octet-stream",
  standard: "model/gltf-binary",
  buckets: "application/json",
};

it("publishes every file the assembly wrote under library-bake/, records as bytes and GLBs as glTF, with the pinned index under its pinned hash", async () => {
  const inputs = await build([
    [{ id: "ldraw:3001" }, { id: "ldraw:3040b" }],
    [{ id: "ldraw:3626c" }],
  ]);
  const pin = await assembleLibraryBake({ ...inputs, source: SOURCE, options: OPTIONS });
  const store = new RecordingStore();

  await uploadPublication(libraryBakePublication, store, inputs.out, pin);

  const indexKey = `library-bake/library-bake.${pin.index.sha256.slice(0, 16)}.json`;
  expect(publicationIndexKey(libraryBakePublication, pin)).toBe(indexKey);
  const addressed = (await filesUnder(inputs.out)).filter((file) => file !== LIBRARY_BAKE_INDEX);
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

it("the library-bake pointer's manifest references its index, every bucket, and every record and GLB", async () => {
  const inputs = await build([
    [{ id: "ldraw:3001" }, { id: "ldraw:3040b" }],
    [{ id: "ldraw:3626c" }],
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

  const files = (await filesUnder(inputs.out)).filter((file) => file !== LIBRARY_BAKE_INDEX);
  expect([...indexes, ...leaves].toSorted()).toEqual(
    [
      `library-bake/${contentAddressedName(LIBRARY_BAKE_INDEX, pin.index.sha256)}`,
      ...files.map((file) => `library-bake/${file}`),
    ].toSorted(),
  );
  expect(leaves.every((key) => !key.startsWith("library-bake/buckets/"))).toBe(true);
});
