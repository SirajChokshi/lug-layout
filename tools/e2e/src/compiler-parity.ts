import { BrickCompiler, type CompileLod, type CompileOutput } from "@brr/import";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";

interface ManifestFile {
  readonly file: string;
}

interface Manifest {
  readonly bundleVersion: string;
  readonly models: ReadonlyArray<ManifestFile & { readonly name: string }>;
  readonly parts: ReadonlyArray<ManifestFile & { readonly id: string }>;
  readonly studPrimitives: ReadonlyArray<ManifestFile & { readonly name: string }>;
  readonly compiler: ManifestFile & { readonly unofficialAllowlist: ReadonlyArray<string> };
}

const GLB_HEADER_BYTES = 12;
const MATRIX_FLOATS = 12;
const CHUNK_HEADER_BYTES = 8;
const LIBRARY_PREFIXES = ["parts/", "p/"] as const;
const LODS: ReadonlyArray<CompileLod> = ["standard", "low", "far"];

const { values } = parseArgs({
  options: {
    bundle: { type: "string", default: "../asset-pipeline/dist/bundle" },
    ldraw: { type: "string", default: "../../.cache/ldraw" },
    omr: { type: "string", default: "../../.cache/omr" },
  },
});

async function libraryFiles(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files[relative(root, path).replaceAll("\\", "/").toLowerCase()] = await readFile(path, "utf8");
  }
  return files;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function glbSourceFile(glb: Uint8Array): string {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const jsonLength = view.getUint32(GLB_HEADER_BYTES, true);
  const start = GLB_HEADER_BYTES + CHUNK_HEADER_BYTES;
  const json: unknown = JSON.parse(
    new TextDecoder().decode(glb.subarray(start, start + jsonLength)),
  );
  const file = (json as { extras?: { ldraw?: { file?: unknown } } }).extras?.ldraw?.file;
  if (typeof file !== "string") throw new Error("GLB has no extras.ldraw.file");
  return file;
}

function referenceOf(file: string): string {
  const prefix = LIBRARY_PREFIXES.find((candidate) => file.startsWith(candidate));
  return prefix ? file.slice(prefix.length) : file;
}

const files = await libraryFiles(values.ldraw);
let total = 0;
let identical = 0;
for (const lod of LODS) {
  const directory = join(values.bundle, lod);
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as Manifest;
  const compiler = new BrickCompiler(
    new WebAssembly.Module(await readFile(join(directory, manifest.compiler.file))),
  );
  const bundled = new Map<string, Uint8Array>();
  for (const part of manifest.parts) {
    bundled.set(part.id, new Uint8Array(await readFile(join(directory, part.file))));
  }
  const references = new Map<string, string>();
  for (const [id, glb] of bundled) references.set(referenceOf(glbSourceFile(glb)), id);
  const started = performance.now();
  const absent = new Set<string>();
  let rounds = 0;
  let output: CompileOutput;
  for (;;) {
    rounds++;
    output = await compiler.compile({
      lod,
      studPrimitives: manifest.studPrimitives.map((primitive) => primitive.name),
      unofficialAllowlist: manifest.compiler.unofficialAllowlist,
      files,
      absent: [...absent],
      parts: [...references.keys()],
      model: "",
      inlineChecks: [],
    });
    const requested = output.parts.flatMap((outcome) =>
      outcome.status === "need" ? outcome.paths : [],
    );
    if (requested.length === 0) break;
    for (const path of requested) {
      if (path in files) throw new Error(`compiler asked for ${path}, which it was given`);
      absent.add(path);
    }
  }
  const elapsed = performance.now() - started;
  const mismatches: string[] = [];
  for (const outcome of output.parts) {
    const id = references.get(outcome.reference) ?? outcome.reference;
    const expected = bundled.get(id);
    total++;
    if (outcome.status === "compiled" && expected && sha256(outcome.glb) === sha256(expected)) {
      identical++;
    } else {
      mismatches.push(`${id}: ${outcome.status === "compiled" ? "bytes differ" : outcome.status}`);
    }
  }
  process.stdout.write(
    `${lod} ${manifest.bundleVersion}: ${output.parts.length - mismatches.length} of ${output.parts.length} part GLBs byte-identical (WASM compile ${elapsed.toFixed(0)} ms over ${rounds} rounds)\n`,
  );
  for (const mismatch of mismatches) process.stdout.write(`  ${mismatch}\n`);
}
process.stdout.write(`total: ${identical} of ${total} byte-identical\n`);
if (identical !== total) process.exitCode = 1;

interface ModelFile {
  readonly parts: ReadonlyArray<string>;
  readonly instances: {
    readonly part: ReadonlyArray<number>;
    readonly color: ReadonlyArray<number>;
    readonly matrix: ReadonlyArray<number>;
  };
}

function bundlePartId(reference: string): string {
  return `ldraw:${reference.replace(/(\.dat)+$/u, "").replaceAll("/", "-")}`;
}

const standard = join(values.bundle, "standard");
const standardManifest = JSON.parse(
  await readFile(join(standard, "manifest.json"), "utf8"),
) as Manifest;
const baker = new BrickCompiler(
  new WebAssembly.Module(await readFile(join(standard, standardManifest.compiler.file))),
);
for (const model of standardManifest.models) {
  const bundled = JSON.parse(await readFile(join(standard, model.file), "utf8")) as ModelFile;
  const baked = await baker.bake(await readFile(join(values.omr, `${model.name}.mpd`), "utf8"));
  const count = baked.instances.part.length;
  let differing = 0;
  for (let i = 0; i < Math.max(count, bundled.instances.part.length); i++) {
    const samePart =
      bundlePartId(baked.parts[baked.instances.part[i] ?? -1] ?? "") ===
      bundled.parts[bundled.instances.part[i] ?? -1];
    const sameColor = baked.instances.color[i] === bundled.instances.color[i];
    let sameMatrix = true;
    for (let k = 0; k < MATRIX_FLOATS; k++) {
      const bakedValue = Math.fround(baked.instances.matrix[i * MATRIX_FLOATS + k] ?? Number.NaN);
      if (bakedValue !== bundled.instances.matrix[i * MATRIX_FLOATS + k]) sameMatrix = false;
    }
    if (!samePart || !sameColor || !sameMatrix) differing++;
  }
  process.stdout.write(
    `bake ${model.name}: ${count} instances, bundle ${bundled.instances.part.length}, ${differing} differing (part, colour, float32 matrix)\n`,
  );
  if (differing > 0) process.exitCode = 1;
}
