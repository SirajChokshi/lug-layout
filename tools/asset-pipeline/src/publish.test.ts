import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MANIFEST_FILE, publishBundle } from "./publish.ts";

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
    milsEdgeRules: {
      source: "test",
      moduleStuds: 32,
      surfacePlates: 4,
      surfaceTolerancePlates: 1,
      features: [],
    },
    compiler: null,
    crosswalk: { file: "crosswalk.json" },
    partTable: { file: "parts.json" },
    creditTable: { file: "credits.json" },
  };
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
  readonly files: Map<string, Buffer>;
}

const inputs = { ldraw: source, omr: source, lockSha256: SHA256_ZERO, paletteSha256: SHA256_ZERO };
const directories: string[] = [];

async function publish(edit: (bundle: CompiledBundle) => void) {
  const directory = await mkdtemp(join(tmpdir(), "brr-publish-"));
  directories.push(directory);
  const bundle = {
    manifest: compiledManifest(),
    gltf: studGltf(),
    model: modelFile(),
    crosswalk: crosswalkFile(),
    parts: [],
    files: new Map<string, Buffer>(),
  };
  edit(bundle);
  await writeFile(join(directory, MANIFEST_FILE), JSON.stringify(bundle.manifest));
  await writeFile(join(directory, "stud.glb"), glb(bundle.gltf));
  await writeFile(join(directory, "model-scene.json"), JSON.stringify(bundle.model));
  await writeFile(join(directory, "crosswalk.json"), JSON.stringify(bundle.crosswalk));
  await writeFile(join(directory, "parts.json"), JSON.stringify({ parts: bundle.parts }));
  await writeFile(join(directory, "credits.json"), JSON.stringify({ credits: [] }));
  for (const [name, bytes] of bundle.files) await writeFile(join(directory, name), bytes);
  return { directory, published: await publishBundle(directory, inputs) };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("publishBundle", () => {
  it("publishes a bundle whose every key is declared", async () => {
    await expect(publish(() => undefined)).resolves.toMatchObject({ published: { files: 5 } });
  });

  it("points every record at the content-addressed GLB of its parts", async () => {
    const { directory } = await publish((bundle) => {
      const part = {
        id: "ldraw:3001",
        path: "parts/3001.dat",
        role: "detail",
        file: "3001.glb",
        title: "Brick 2 x 4",
        author: "James Jessiman",
        license: null,
        bounds: origin,
        colors: [16],
        studs: 0,
        triangles: 0,
        vertices: 0,
        baseplate: false,
        aliasOf: null,
      };
      const shape = { id: part.id, title: part.title, role: part.role, file: part.file };
      bundle.parts.push(part);
      bundle.files.set(part.file, glb(studGltf()));
      bundle.model.parts.push(part.id);
      bundle.model.shapes.push({ ...shape, bounds: origin, baseplate: false, studs: [] });
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
});
