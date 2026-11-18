import { CONNECTIVITY_LICENSE, CONNECTOR_SOURCE } from "@brr/schema/bundle";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  attachSectionVocabulary,
  MANIFEST_FILE,
  publishBundle,
  SECTION_VOCABULARY_FILE,
} from "./publish.ts";
import { CA_LICENSE_LINES } from "./verify/license-audit.ts";
import { encodePng } from "./thumbnails/png.ts";
import { THUMBNAIL_PX } from "./thumbnails/rasterizer.ts";

const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const GLB_HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;
const CHUNK_JSON = 0x4e4f534a;
const SHA256_ZERO = "0".repeat(64);

const source = { kind: "github-mirror" as const, repo: "owner/repo", commit: "abc", root: "ldraw" };
const origin = { min: [0, 0, 0], max: [0, 0, 0] };

function compiledManifest() {
  return {
    unit: "LDU",
    upAxis: "+Y",
    lod: "standard",
    source,
    studPrimitives: [
      {
        name: "stud.dat",
        path: "p/stud.dat",
        file: "stud.glb",
        bounds: origin,
        colors: [16],
        studs: 0,
        triangles: 0,
        vertices: 0,
      },
    ],
    colors: [],
    models: [
      {
        name: "scene",
        file: "model-scene.json",
        origin: "generated",
        set: null,
        source: "generated",
        authors: [],
        licenses: [],
        sections: [],
        inlinePartsResolvedToOfficial: [],
        instances: 0,
        lattice: null,
        vehicles: 0,
        sha256: SHA256_ZERO,
        cover: { studs: 0, coveredStuds: 0, keptOpenBelow: 0, cells: null },
      },
    ],
    modified: "modified from LDraw",
    disclaimer: "not affiliated",
    catalogParts: [],
    trackCatalog: { n: 16, pieces: [] },
    trackShapes: [],
    tablePlane: { part: "3811", depthBelowTopLdu: 4 },
    compiler: null as { file: string; unofficialAllowlist: string[]; cavityProbe: string } | null,
    crosswalk: { file: "crosswalk.json" },
    partTable: { file: "parts.json" },
    creditTable: { file: "credits.json" },
    connectors: { file: "connector-index.json" },
    connectivity: { file: "connectivity-index.json" },
    thumbnails: [] as Array<{ item: string; file: string }>,
  };
}

const BRICK = "ldraw:3001";
const [PART_LICENSE = ""] = CA_LICENSE_LINES;

function connectorRecord(license: string, tier: number) {
  return {
    part: BRICK,
    license,
    faces: {
      gender: [0],
      source: [tier],
      status: [0],
      caps: [0],
      slide: [false],
      group: [""],
      origin: [0, 0, 0],
      axis: [0],
      sectionStart: [0],
      sectionCount: [1],
      sectionCode: [0],
      sectionSize: [6],
      sectionLength: [8],
    },
    free: { face: [] as number[], origin: [] as number[], axis: [] as number[] },
    unreadable: [] as string[],
  };
}

function connectorIndex(
  pkg: "connectivity" | "connectors",
  licenses: string[],
  attribution: string[],
) {
  return {
    package: pkg,
    licenses,
    attribution,
    source,
    parts: { [BRICK]: { file: `${pkg}-3001.json` } } as Record<string, { file: string } | null>,
  };
}

function sectionVocabulary() {
  return {
    source: { kind: "github-archive" as const, repo: source.repo, commit: source.commit, root: "" },
    archive: { file: "shadow.tar.gz", sha256: SHA256_ZERO },
    license: CONNECTIVITY_LICENSE,
    attribution: [
      "Section sizes and lengths derived from the LDCad Shadow Library by Roland Melkert",
    ],
    sizes: [
      { gender: "M", shape: "R", size: 6 },
      { gender: "F", shape: "R", size: 6 },
    ],
    lengths: [{ shape: "R", length: 8 }],
  };
}

function png(size: number): Buffer {
  return encodePng(size, size, new Uint8Array(size * size * 4));
}

function crosswalkFile() {
  return {
    format: 1,
    sources: {},
    parts: {
      "ldraw:3001": {
        rebrickable: "3001",
        bricklink: "3001",
        via: { rebrickable: "rebrickable-api", bricklink: "rebrickable-api" },
      },
    },
    colors: { "4": { name: "Red", rebrickable: 4, bricklink: 5 } },
    bricklinkParts: { "3001": ["ldraw:3001"] },
    bricklinkPartVariants: {},
    bricklinkColors: { "5": [4] },
  };
}

function studGltf() {
  return {
    asset: { version: "2.0", generator: "brick-compile" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: "p/stud.dat" }],
    meshes: [{ name: "p/stud.dat", primitives: [] }],
    accessors: [],
    bufferViews: [],
    buffers: [{ byteLength: 0 }],
    extras: {
      unit: "LDU",
      upAxis: "+Y",
      ldraw: {
        file: "p/stud.dat",
        name: "stud.dat",
        title: "Stud",
        author: "James Jessiman",
        license: null,
        ldrawOrg: null,
        note: "modified from LDraw",
      },
      sources: [],
      studs: [],
      bounds: origin,
    },
  };
}

function modelFile() {
  return {
    name: "scene",
    file: "scene.ldr",
    source: "generated",
    retrieved: "2026-11-17T00:00:00Z",
    sha256: SHA256_ZERO,
    sections: [],
    inlinePartsResolvedToOfficial: [],
    parts: [] as string[],
    shapes: [] as unknown[],
    lattice: null,
    vehicles: [],
    cover: { studs: 0, coveredStuds: 0, keptOpenBelow: 0, visibleBits: [], cells: null },
    instances: { part: [], color: [], matrix: [] },
    partTransforms: [],
    submodels: { parent: [], matrices: [], ofPart: [] },
  };
}

function glb(document: unknown): Buffer {
  const text = JSON.stringify(document);
  const json = Buffer.from(text.padEnd(Math.ceil(text.length / 4) * 4, " "));
  const header = Buffer.alloc(GLB_HEADER_BYTES + CHUNK_HEADER_BYTES);
  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(GLB_VERSION, 4);
  header.writeUInt32LE(header.length + json.length, 8);
  header.writeUInt32LE(json.length, GLB_HEADER_BYTES);
  header.writeUInt32LE(CHUNK_JSON, GLB_HEADER_BYTES + 4);
  return Buffer.concat([header, json]);
}

interface CompiledBundle {
  readonly manifest: ReturnType<typeof compiledManifest>;
  readonly gltf: ReturnType<typeof studGltf>;
  readonly model: ReturnType<typeof modelFile>;
  readonly crosswalk: ReturnType<typeof crosswalkFile>;
  readonly parts: Array<Record<string, unknown>>;
  readonly connectivityIndex: ReturnType<typeof connectorIndex>;
  readonly connectivityRecord: ReturnType<typeof connectorRecord>;
  readonly connectorIndex: ReturnType<typeof connectorIndex>;
  readonly connectorRecord: ReturnType<typeof connectorRecord>;
  readonly files: Map<string, Buffer>;
  vocabulary: ReturnType<typeof sectionVocabulary> | null;
  readonly afterAttach: Array<(directory: string) => Promise<void>>;
}

const inputs = { ldraw: source, omr: source, lockSha256: SHA256_ZERO, paletteSha256: SHA256_ZERO };
const directories: string[] = [];

async function publish(edit: (bundle: CompiledBundle) => void) {
  const directory = await mkdtemp(join(tmpdir(), "brr-publish-"));
  directories.push(directory);
  const bundle: CompiledBundle = {
    manifest: compiledManifest(),
    gltf: studGltf(),
    model: modelFile(),
    crosswalk: crosswalkFile(),
    parts: [],
    connectivityIndex: connectorIndex(
      "connectivity",
      [CONNECTIVITY_LICENSE],
      ["LDCad Shadow Library by Roland Melkert"],
    ),
    connectivityRecord: connectorRecord(CONNECTIVITY_LICENSE, CONNECTOR_SOURCE.shadow),
    connectorIndex: connectorIndex("connectors", [PART_LICENSE], []),
    connectorRecord: connectorRecord(PART_LICENSE, CONNECTOR_SOURCE.primitive),
    files: new Map<string, Buffer>(),
    vocabulary: null,
    afterAttach: [],
  };
  edit(bundle);
  const connectorFiles = {
    "connectivity-index.json": bundle.connectivityIndex,
    "connectivity-3001.json": bundle.connectivityRecord,
    "connector-index.json": bundle.connectorIndex,
    "connectors-3001.json": bundle.connectorRecord,
  };
  for (const [name, value] of Object.entries(connectorFiles)) {
    await writeFile(join(directory, name), JSON.stringify(value));
  }
  await writeFile(join(directory, MANIFEST_FILE), JSON.stringify(bundle.manifest));
  await writeFile(join(directory, "stud.glb"), glb(bundle.gltf));
  await writeFile(join(directory, "model-scene.json"), JSON.stringify(bundle.model));
  await writeFile(join(directory, "crosswalk.json"), JSON.stringify(bundle.crosswalk));
  await writeFile(join(directory, "parts.json"), JSON.stringify({ parts: bundle.parts }));
  await writeFile(join(directory, "credits.json"), JSON.stringify({ credits: [] }));
  for (const [name, bytes] of bundle.files) {
    await mkdir(dirname(join(directory, name)), { recursive: true });
    await writeFile(join(directory, name), bytes);
  }
  if (bundle.vocabulary !== null) {
    const committed = await mkdtemp(join(tmpdir(), "brr-vocabulary-"));
    directories.push(committed);
    const vocabularyPath = join(committed, SECTION_VOCABULARY_FILE);
    await writeFile(vocabularyPath, `${JSON.stringify(bundle.vocabulary, null, 2)}\n`);
    await attachSectionVocabulary(directory, vocabularyPath);
  }
  for (const tamper of bundle.afterAttach) await tamper(directory);
  return { directory, published: await publishBundle(directory, inputs) };
}

const COMPILER_FILE = "compiler.wasm";

function withCompiler(bundle: CompiledBundle): ReturnType<typeof sectionVocabulary> {
  bundle.manifest.compiler = {
    file: COMPILER_FILE,
    unofficialAllowlist: [],
    cavityProbe: "p/stud.dat",
  };
  bundle.files.set(COMPILER_FILE, Buffer.from("compiler bytes"));
  const vocabulary = sectionVocabulary();
  bundle.vocabulary = vocabulary;
  return vocabulary;
}

async function editJson(path: string, edit: (value: Record<string, unknown>) => void) {
  const value: Record<string, unknown> = JSON.parse(await readFile(path, "utf8"));
  edit(value);
  await writeFile(path, JSON.stringify(value));
}

function withThumbnail(bytes: Buffer) {
  return ({ manifest, files }: CompiledBundle) => {
    manifest.thumbnails.push({ item: "ldraw:3811@2", file: "thumb/ldraw-3811-2.png" });
    files.set("thumb/ldraw-3811-2.png", bytes);
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("publishBundle", () => {
  it("publishes a bundle whose every key is declared", async () => {
    await expect(publish(() => undefined)).resolves.toMatchObject({ published: { files: 9 } });
  });

  it("points each connector index at the content-addressed record of its part", async () => {
    const { directory } = await publish(() => undefined);
    const manifest = JSON.parse(await readFile(join(directory, MANIFEST_FILE), "utf8"));
    for (const [pkg, written] of [
      ["connectivity", connectorRecord(CONNECTIVITY_LICENSE, CONNECTOR_SOURCE.shadow)],
      ["connectors", connectorRecord(PART_LICENSE, CONNECTOR_SOURCE.primitive)],
    ] as const) {
      const index = JSON.parse(await readFile(join(directory, manifest[pkg].file), "utf8"));
      const { file } = index.parts[BRICK];
      expect(file).toMatch(new RegExp(`^${pkg}-3001\\.[0-9a-f]{16}\\.json$`, "u"));
      expect(JSON.parse(await readFile(join(directory, file), "utf8"))).toEqual(written);
    }
  });

  it.each([
    {
      file: "a tier 1 face in the connectors package",
      edit: ({ connectorRecord: record }: CompiledBundle) => {
        record.faces.source[0] = CONNECTOR_SOURCE.shadow;
      },
      refusal: `ldraw:3001's connector record carries 1 tier 1 faces, which belong only in the ${CONNECTIVITY_LICENSE} connectivity package`,
    },
    {
      file: "a primitive face in the connectivity package",
      edit: ({ connectivityRecord: record }: CompiledBundle) => {
        record.faces.source[0] = CONNECTOR_SOURCE.primitive;
      },
      refusal: "ldraw:3001's connectivity record carries 1 faces from outside tier 1",
    },
    {
      file: "a connectivity package under another licence",
      edit: ({ connectivityIndex: index, connectivityRecord: record }: CompiledBundle) => {
        index.licenses = [PART_LICENSE];
        record.license = PART_LICENSE;
      },
      refusal: `the connectivity package declares ["${PART_LICENSE}"], not only ${CONNECTIVITY_LICENSE}`,
    },
    {
      file: "a connectivity package without attribution",
      edit: ({ connectivityIndex: index }: CompiledBundle) => {
        index.attribution = [];
      },
      refusal: "the connectivity package names no attribution",
    },
    {
      file: "a connector record under a licence other than an LDraw CA licence",
      edit: ({ connectorIndex: index, connectorRecord: record }: CompiledBundle) => {
        index.licenses = ["Not redistributable : see NonCAreadme.txt"];
        record.license = "Not redistributable : see NonCAreadme.txt";
      },
      refusal:
        "the connectors package declares Not redistributable : see NonCAreadme.txt, which is not an LDraw CA licence",
    },
    {
      file: "a record filed under another part",
      edit: ({ connectorIndex: index }: CompiledBundle) => {
        index.parts = { "ldraw:3002": index.parts[BRICK] ?? null };
      },
      refusal: "the connectors index files ldraw:3001 under ldraw:3002",
    },
  ])("refuses $file", async ({ edit, refusal }) => {
    await expect(publish(edit)).rejects.toThrow(refusal);
  });

  it("points every record at the content-addressed GLB of its parts", async () => {
    const { directory } = await publish((bundle) => {
      const part = {
        id: "ldraw:3001",
        path: "parts/3001.dat",
        role: "detail",
        file: "3001.glb",
        title: "Brick 2 x 4",
        ldrawCategory: "Brick",
        keywords: [],
        author: "James Jessiman",
        license: null,
        bounds: origin,
        colors: [16],
        studs: 0,
        triangles: 0,
        vertices: 0,
      };
      const shape = { id: part.id, title: part.title, role: part.role, file: part.file };
      bundle.parts.push(part);
      bundle.files.set(part.file, glb(studGltf()));
      bundle.model.parts.push(part.id);
      bundle.model.shapes.push({ ...shape, bounds: origin, studs: [] });
    });
    const names = await readdir(directory);
    const manifest = JSON.parse(await readFile(join(directory, MANIFEST_FILE), "utf8"));
    const model = JSON.parse(await readFile(join(directory, manifest.models[0].file), "utf8"));
    const table = JSON.parse(await readFile(join(directory, manifest.partTable.file), "utf8"));
    const addressed = names.find((name) => /^3001\.[0-9a-f]{16}\.glb$/u.test(name));
    expect(addressed).toBeDefined();
    expect(model.shapes[0].file).toBe(addressed);
    expect(table.parts[0].file).toBe(addressed);
  });

  it("publishes the section vocabulary byte for byte as its own content-addressed asset, which the manifest references with its SHA-256", async () => {
    const { directory, published } = await publish(withCompiler);
    expect(published.files).toBe(11);
    const manifest = JSON.parse(await readFile(join(directory, MANIFEST_FILE), "utf8"));
    const { file, sha256 } = manifest.compiler.sectionVocabulary;
    expect(file).toMatch(/^section-vocabulary\.[0-9a-f]{16}\.json$/u);
    const written = `${JSON.stringify(sectionVocabulary(), null, 2)}\n`;
    expect((await readFile(join(directory, file))).toString("utf8")).toBe(written);
    expect(sha256).toBe(createHash("sha256").update(written).digest("hex"));
  });

  it.each([
    {
      file: "section vocabulary values inlined in the manifest's compiler section",
      edit: (bundle: CompiledBundle) => {
        const { sizes, lengths } = withCompiler(bundle);
        bundle.afterAttach.push((directory) =>
          editJson(join(directory, MANIFEST_FILE), (manifest) => {
            manifest["compiler"] = {
              ...bundle.manifest.compiler,
              sectionVocabulary: { sizes, lengths },
            };
          }),
        );
      },
      refusal:
        "manifest.json carries section vocabulary values at $.compiler.sectionVocabulary.sizes[0], $.compiler.sectionVocabulary.sizes[1], $.compiler.sectionVocabulary.lengths[0]; they ship only in the CC BY-SA section vocabulary asset",
    },
    {
      file: "a section vocabulary entry in a CC BY connector record",
      edit: (bundle: CompiledBundle) => {
        const { sizes } = withCompiler(bundle);
        Object.assign(bundle.connectorRecord, { sections: sizes.slice(0, 1) });
      },
      refusal:
        "connectors-3001.json carries section vocabulary values at $.sections[0]; they ship only in the CC BY-SA section vocabulary asset",
    },
    {
      file: "a section vocabulary entry in a GLB's JSON chunk",
      edit: (bundle: CompiledBundle) => {
        const { lengths } = withCompiler(bundle);
        Object.assign(bundle.gltf.extras, { section: lengths[0] });
      },
      refusal:
        "stud.glb carries section vocabulary values at $.extras.section; they ship only in the CC BY-SA section vocabulary asset",
    },
    {
      file: "a section vocabulary under another licence",
      edit: (bundle: CompiledBundle) => {
        withCompiler(bundle).license = PART_LICENSE;
      },
      refusal: `section-vocabulary.json: the section vocabulary is licensed ${PART_LICENSE}, not ${CONNECTIVITY_LICENSE}`,
    },
    {
      file: "a section vocabulary without attribution",
      edit: (bundle: CompiledBundle) => {
        withCompiler(bundle).attribution = [];
      },
      refusal: "section-vocabulary.json: the section vocabulary names no attribution",
    },
    {
      file: "a section vocabulary derived from another shadow commit than the connectivity package",
      edit: (bundle: CompiledBundle) => {
        withCompiler(bundle).source.commit = "def";
      },
      refusal:
        "section-vocabulary.json: the section vocabulary is derived from owner/repo@def, but the connectivity package from owner/repo@abc",
    },
    {
      file: "a section vocabulary whose bytes are not the ones the manifest's SHA-256 names",
      edit: (bundle: CompiledBundle) => {
        withCompiler(bundle);
        bundle.afterAttach.push((directory) =>
          editJson(join(directory, SECTION_VOCABULARY_FILE), () => undefined),
        );
      },
      refusal: "but the manifest references",
    },
  ])("refuses $file", async ({ edit, refusal }) => {
    await expect(publish(edit)).rejects.toThrow(refusal);
  });

  it.each([
    {
      file: "the manifest",
      edit: ({ manifest }: CompiledBundle) => {
        Object.assign(manifest.models[0] ?? {}, { vehicleCount: 0 });
      },
      refusal: "manifest.json: no schema declares $.models[].vehicleCount",
    },
    {
      file: "a GLB's JSON chunk",
      edit: ({ gltf }: CompiledBundle) => {
        Object.assign(gltf.extras.ldraw, { authorEmail: "" });
      },
      refusal: "stud.glb: no schema declares $.extras.ldraw.authorEmail",
    },
    {
      file: "a model file",
      edit: ({ model }: CompiledBundle) => {
        Object.assign(model.instances, { scale: [] });
      },
      refusal: "model-scene.json: no schema declares $.instances.scale",
    },
    {
      file: "the crosswalk",
      edit: ({ crosswalk }: CompiledBundle) => {
        Object.assign(crosswalk.parts["ldraw:3001"] ?? {}, { popularity: 9 });
      },
      refusal: "crosswalk.json: no schema declares $.parts.ldraw:3001.popularity",
    },
  ])("refuses an undeclared key nested in $file", async ({ edit, refusal }) => {
    await expect(publish(edit)).rejects.toThrow(refusal);
  });

  it("publishes each thumbnail in thumb/ under its content address", async () => {
    const { directory, published } = await publish(withThumbnail(png(THUMBNAIL_PX)));
    expect(published.files).toBe(10);
    const manifest = JSON.parse(await readFile(join(directory, MANIFEST_FILE), "utf8"));
    const [thumbnail] = manifest.thumbnails;
    expect(thumbnail.item).toBe("ldraw:3811@2");
    expect(thumbnail.file).toMatch(/^thumb\/ldraw-3811-2\.[0-9a-f]{16}\.png$/u);
    expect(await readFile(join(directory, thumbnail.file))).toEqual(png(THUMBNAIL_PX));
  });

  it.each([
    {
      file: "a thumbnail of the wrong size",
      edit: withThumbnail(png(THUMBNAIL_PX / 2)),
      refusal: `thumb/ldraw-3811-2.png is 56×56, not ${THUMBNAIL_PX}×${THUMBNAIL_PX}`,
    },
    {
      file: "a thumbnail that is not a PNG",
      edit: withThumbnail(Buffer.from("not an image, just some text bytes")),
      refusal: "thumb/ldraw-3811-2.png is not a PNG file",
    },
    {
      file: "an unreferenced file in a subdirectory",
      edit: ({ files }: CompiledBundle) => {
        files.set("thumb/stray.png", png(THUMBNAIL_PX));
      },
      refusal: "has files the manifest does not reference: thumb/stray.png",
    },
  ])("refuses $file", async ({ edit, refusal }) => {
    await expect(publish(edit)).rejects.toThrow(refusal);
  });
});
