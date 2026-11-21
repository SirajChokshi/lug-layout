import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import type { InputLock } from "../fetch-ldraw.ts";
import { sha256Hex, type ObjectStore } from "../r2.ts";
import {
  extractLibrary,
  uploadLibrary,
  verifyServedLibrary,
  type ObjectReader,
} from "./ldraw-library.ts";

const TAR_BLOCK = 512;
const TAR_END_BLOCKS = 2;
const CA_LICENSE = "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt";
const NON_CA_LICENSE = "0 !LICENSE Not redistributable : see NonCAreadme.txt";
const SOURCE = {
  kind: "github-mirror" as const,
  repo: "owner/library",
  commit: "c0ffee",
  root: "ldraw",
};
const TOP = "library-c0ffee";
const ARCHIVE_FILE = "library.tar.gz";

function ldrawFile(name: string, license = CA_LICENSE, org = "Part"): string {
  return [
    `0 ${name}`,
    `0 Name: ${name}`,
    "0 Author: Test",
    `0 !LDRAW_ORG ${org}`,
    license,
    "",
  ].join("\r\n");
}

const BRICK = ldrawFile("3001.dat");
const STUD = ldrawFile("stud.dat", CA_LICENSE, "Primitive");
const LDCONFIG = "0 LDraw.org Configuration File\n";
const LIBRARY: Readonly<Record<string, string>> = {
  "parts/3001.dat": BRICK,
  "parts/s/3001s01.dat": ldrawFile("s\\3001s01.dat", CA_LICENSE, "Subpart"),
  "p/stud.dat": STUD,
  "p/8/stud.dat": ldrawFile("8\\stud.dat", CA_LICENSE, "8_Primitive"),
  "CAlicense4.txt": "Creative Commons Attribution 4.0\n",
  "LDConfig.ldr": LDCONFIG,
  "models/car.ldr": "0 Car\n",
  "parts/textures/39266b.png": "png",
  "mklist.exe": "MZ",
};
const OUTSIDE_ROOT: Readonly<Record<string, string>> = { "README.md": "# mirror\n" };
const PUBLISHED = [
  "CAlicense4.txt",
  "p/8/stud.dat",
  "p/stud.dat",
  "parts/3001.dat",
  "parts/s/3001s01.dat",
];

function tarGz(files: Readonly<Record<string, string>>): Uint8Array {
  const blocks: Buffer[] = [];
  for (const [path, text] of Object.entries(files)) {
    const body = Buffer.from(text);
    const header = Buffer.alloc(TAR_BLOCK);
    header.write(path, 0);
    header.write("0000644\0", 100);
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    blocks.push(header, body, Buffer.alloc((TAR_BLOCK - (body.length % TAR_BLOCK)) % TAR_BLOCK));
  }
  blocks.push(Buffer.alloc(TAR_BLOCK * TAR_END_BLOCKS));
  return gzipSync(Buffer.concat(blocks));
}

function archiveOf(library: Readonly<Record<string, string>>): Uint8Array {
  return tarGz(
    Object.fromEntries([
      ...Object.entries(OUTSIDE_ROOT).map(([path, text]) => [`${TOP}/${path}`, text]),
      ...Object.entries(library).map(([path, text]) => [`${TOP}/${SOURCE.root}/${path}`, text]),
    ]),
  );
}

function lockFor(archive: Uint8Array, pinned: Readonly<Record<string, string>>): InputLock {
  return {
    source: SOURCE,
    files: Object.fromEntries(
      Object.entries(pinned).map(([path, text]) => [path, sha256Hex(text)]),
    ),
    catalog: {
      "ldraw-library": {
        use: "crosswalk",
        source: { ...SOURCE, kind: "github-archive" },
        files: { [ARCHIVE_FILE]: sha256Hex(archive) },
      },
    },
  };
}

class MemoryStore implements ObjectStore {
  readonly objects = new Map<string, { body: Uint8Array; headers: Record<string, string> }>();
  readonly order: string[] = [];

  async has(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async put(key: string, body: Uint8Array, headers: Readonly<Record<string, string>>) {
    this.objects.set(key, { body, headers: { ...headers } });
    this.order.push(key);
  }

  readonly read: ObjectReader = async (key) => this.objects.get(key)?.body;
}

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function workspace(archive: Uint8Array): Promise<{ archivePath: string; out: string }> {
  const directory = await mkdtemp(join(tmpdir(), "ldraw-library-"));
  directories.push(directory);
  const archivePath = join(directory, ARCHIVE_FILE);
  await writeFile(archivePath, archive);
  return { archivePath, out: join(directory, "extracted") };
}

async function published(
  library: Readonly<Record<string, string>>,
  pinned: Readonly<Record<string, string>>,
) {
  const archive = archiveOf(library);
  const lock = lockFor(archive, pinned);
  const { archivePath, out } = await workspace(archive);
  const { index, problems } = await extractLibrary(archivePath, lock, out);
  expect(problems).toEqual([]);
  const store = new MemoryStore();
  await uploadLibrary(store, index, out);
  return { store, lock, index, out };
}

describe("LDraw library publishing", () => {
  it("publishes parts/ and p/ files and the root license texts at the GitHub raw paths, index last, and verifies what it served", async () => {
    const { store, lock } = await published(LIBRARY, {
      "parts/3001.dat": BRICK,
      "LDConfig.ldr": LDCONFIG,
    });

    const prefix = "owner/library/c0ffee/ldraw/";
    const indexKey = "index/owner/library/c0ffee/ldraw.v1.json";
    expect([...store.objects.keys()].toSorted()).toEqual(
      [indexKey, ...PUBLISHED.map((path) => prefix + path)].toSorted(),
    );
    expect(store.order.at(-1)).toBe(indexKey);
    expect(store.objects.get(`${prefix}parts/3001.dat`)?.headers).toEqual({
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=31536000, immutable",
    });
    expect(new TextDecoder().decode(store.objects.get(`${prefix}p/stud.dat`)?.body)).toBe(STUD);
    expect(await verifyServedLibrary(store.read, lock, "all")).toEqual([]);
  });

  it("uploads nothing again once every object is in the bucket", async () => {
    const { store, index, out } = await published(LIBRARY, {});

    expect(await uploadLibrary(store, index, out)).toEqual({
      uploaded: 0,
      present: PUBLISHED.length + 1,
    });
  });

  it("publishes parts whatever licence they name, or none", async () => {
    const { index } = await published(
      {
        ...LIBRARY,
        "parts/nonca.dat": ldrawFile("nonca.dat", NON_CA_LICENSE),
        "p/bare.dat": ldrawFile("bare.dat", "0 no license here"),
      },
      {},
    );

    expect(Object.keys(index.files)).toEqual(
      expect.arrayContaining(["parts/nonca.dat", "p/bare.dat"]),
    );
  });

  it.each([
    {
      name: "a lock-pinned file differs",
      library: LIBRARY,
      pinned: { "parts/3001.dat": "0 something else\n" },
      problem: "parts/3001.dat differs from ldraw.lock.json",
    },
    {
      name: "a lock-pinned file is missing",
      library: LIBRARY,
      pinned: { "parts/9999.dat": "" },
      problem: "ldraw.lock.json pins parts/9999.dat, the archive lacks it",
    },
    {
      name: "a part is unofficial",
      library: {
        ...LIBRARY,
        "parts/u1.dat": ldrawFile("u1.dat", CA_LICENSE, "Unofficial_Part"),
      },
      pinned: {},
      problem: "unofficial file parts/u1.dat",
    },
  ])("refuses to publish when $name", async ({ library, pinned, problem }) => {
    const archive = archiveOf(library);
    const { archivePath, out } = await workspace(archive);

    const { problems } = await extractLibrary(archivePath, lockFor(archive, pinned), out);

    expect(problems).toEqual([problem]);
  });

  it("refuses an archive whose bytes differ from the lock before extracting anything", async () => {
    const pinnedArchive = archiveOf(LIBRARY);
    const { archivePath, out } = await workspace(archiveOf({ ...LIBRARY, "p/extra.dat": "x" }));

    const { problems } = await extractLibrary(archivePath, lockFor(pinnedArchive, {}), out);

    expect(problems).toEqual([
      expect.stringContaining(`ldraw.lock.json pins ${sha256Hex(pinnedArchive)}`),
    ]);
    await expect(readdir(out)).rejects.toThrow("ENOENT");
  });

  it("reports served objects that differ from the index, and an unpublished library", async () => {
    const { store, lock } = await published(LIBRARY, { "parts/3001.dat": BRICK });
    const tampered = "owner/library/c0ffee/ldraw/p/stud.dat";
    await store.put(tampered, new TextEncoder().encode("0 tampered\n"), {});
    store.objects.delete("owner/library/c0ffee/ldraw/parts/3001.dat");

    expect(await verifyServedLibrary(store.read, lock, "pinned")).toEqual([
      "owner/library/c0ffee/ldraw/parts/3001.dat is not served",
    ]);
    expect(await verifyServedLibrary(store.read, lock, "all")).toEqual([
      "owner/library/c0ffee/ldraw/p/stud.dat differs from its pinned SHA-256",
      "owner/library/c0ffee/ldraw/parts/3001.dat is not served",
    ]);
    expect(await verifyServedLibrary(new MemoryStore().read, lock, "pinned")).toEqual([
      "index/owner/library/c0ffee/ldraw.v1.json is not published",
    ]);
  });
});
