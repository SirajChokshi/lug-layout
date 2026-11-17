import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
    parts: [],
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
    credits: [],
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
      },
    ],
    modified: "modified from LDraw",
    disclaimer: "not affiliated",
    trackCatalog: { n: 16, pieces: [] },
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
    parts: [],
    lattice: null,
    vehicles: [],
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
}

const inputs = { ldraw: source, omr: source, lockSha256: SHA256_ZERO, paletteSha256: SHA256_ZERO };
const directories: string[] = [];

async function publish(edit: (bundle: CompiledBundle) => void) {
  const directory = await mkdtemp(join(tmpdir(), "brr-publish-"));
  directories.push(directory);
  const bundle = { manifest: compiledManifest(), gltf: studGltf(), model: modelFile() };
  edit(bundle);
  await writeFile(join(directory, MANIFEST_FILE), JSON.stringify(bundle.manifest));
  await writeFile(join(directory, "stud.glb"), glb(bundle.gltf));
  await writeFile(join(directory, "model-scene.json"), JSON.stringify(bundle.model));
  return publishBundle(directory, inputs);
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("publishBundle", () => {
  it("publishes a bundle whose every key is declared", async () => {
    await expect(publish(() => undefined)).resolves.toMatchObject({ files: 2 });
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
  ])("refuses an undeclared key nested in $file", async ({ edit, refusal }) => {
    await expect(publish(edit)).rejects.toThrow(refusal);
  });
});
