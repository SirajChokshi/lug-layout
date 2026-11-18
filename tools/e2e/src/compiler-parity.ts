import { BrickCompiler, type BakeRequest, type CompileLod, type CompileOutput } from "@brr/import";
import { isDeepStrictEqual } from "node:util";
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
  readonly partTable: ManifestFile;
  readonly studPrimitives: ReadonlyArray<ManifestFile & { readonly name: string }>;
  readonly colors: ReadonlyArray<{ readonly code: number; readonly alpha: number }>;
  readonly compiler: ManifestFile & {
    readonly unofficialAllowlist: ReadonlyArray<string>;
    readonly vehicles?: NonNullable<BakeRequest["vehicles"]>;
  };
}

const GLB_HEADER_BYTES = 12;
const MATRIX_FLOATS = 12;
const CHUNK_HEADER_BYTES = 8;
const LIBRARY_PREFIXES = ["parts/", "p/"] as const;
const LIBRARY_KEY = "parity";
const OPAQUE_ALPHA = 255;
const ALL_LODS: ReadonlyArray<CompileLod> = ["standard", "low", "far"];

const { values } = parseArgs({
  options: {
    bundle: { type: "string", default: "../asset-pipeline/dist/bundle" },
    ldraw: { type: "string", default: "../../.cache/ldraw" },
    omr: { type: "string", default: "../../.cache/omr" },
    fixtures: { type: "string", default: "../../packages/test-fixtures" },
    palette: { type: "string", default: "../asset-pipeline/palette.json" },
    lods: { type: "string", default: ALL_LODS.join(",") },
  },
});

async function libraryFiles(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files.set(
      relative(root, path).replaceAll("\\", "/").toLowerCase(),
      await readFile(path, "utf8"),
    );
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

const lods = ALL_LODS.filter((lod) => values.lods.split(",").includes(lod));
const files = await libraryFiles(values.ldraw);
let total = 0;
let identical = 0;
for (const lod of lods) {
  const directory = join(values.bundle, lod);
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as Manifest;
  const compiler = new BrickCompiler(
    new WebAssembly.Module(await readFile(join(directory, manifest.compiler.file))),
  );
  const bundled = new Map<string, Uint8Array>();
  const { parts } = JSON.parse(
    await readFile(join(directory, manifest.partTable.file), "utf8"),
  ) as { readonly parts: ReadonlyArray<ManifestFile & { readonly id: string }> };
  for (const part of parts) {
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
    output = compiler.compile(
      {
        lod,
        studPrimitives: manifest.studPrimitives.map((primitive) => primitive.name),
        unofficialAllowlist: manifest.compiler.unofficialAllowlist,
        parts: [...references.keys()],
        model: "",
        inlineChecks: [],
      },
      { key: LIBRARY_KEY, files, absent },
    );
    const requested = output.parts.flatMap((outcome) =>
      outcome.status === "need" ? outcome.paths : [],
    );
    if (requested.length === 0) break;
    for (const path of requested) {
      if (files.has(path)) throw new Error(`compiler asked for ${path}, which it was given`);
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
  readonly lattice: unknown;
  readonly vehicles: ReadonlyArray<unknown>;
  readonly cover: {
    readonly studs: number;
    readonly coveredStuds: number;
    readonly visibleBits: ReadonlyArray<number>;
    readonly cells: {
      readonly origin: readonly [number, number];
      readonly size: readonly [number, number];
      readonly bottomY: number;
      readonly footprint: ReadonlyArray<number>;
      readonly flat: ReadonlyArray<number>;
      readonly columnBottom: ReadonlyArray<number>;
      readonly columnTop: ReadonlyArray<number>;
    } | null;
  };
  readonly instances: {
    readonly part: ReadonlyArray<number>;
    readonly color: ReadonlyArray<number>;
    readonly matrix: ReadonlyArray<number>;
  };
  readonly partTransforms: ReadonlyArray<number>;
}

function bundlePartId(reference: string): string {
  return `ldraw:${reference.replace(/(\.dat)+$/u, "").replaceAll("/", "-")}`;
}

interface PaletteModel {
  readonly name: string;
  readonly origin: "omr" | "generated";
  readonly file: string;
  readonly notDrawn?: ReadonlyArray<{ readonly section: string }>;
}

const palette = JSON.parse(await readFile(values.palette, "utf8")) as {
  readonly models: ReadonlyArray<PaletteModel>;
};
const modelRoots: Record<PaletteModel["origin"], string> = {
  omr: values.omr,
  generated: values.fixtures,
};
const standard = join(values.bundle, "standard");
const standardManifest = JSON.parse(
  await readFile(join(standard, "manifest.json"), "utf8"),
) as Manifest;
const baker = new BrickCompiler(
  new WebAssembly.Module(await readFile(join(standard, standardManifest.compiler.file))),
);
const library = { key: LIBRARY_KEY, files, absent: new Set<string>() };
const translucentColors = standardManifest.colors
  .filter((color) => color.alpha < OPAQUE_ALPHA)
  .map((color) => color.code);
let bakesIdentical = 0;
for (const model of standardManifest.models) {
  const bundled = JSON.parse(await readFile(join(standard, model.file), "utf8")) as ModelFile;
  const source = palette.models.find((entry) => entry.name === model.name);
  if (!source) throw new Error(`bundle model ${model.name} is not in the palette`);
  const text = await readFile(join(modelRoots[source.origin], source.file), "utf8");
  const read = baker.readModel(text);
  const officialOf = new Map(read.inlineParts.map((part) => [part.inline, part.official]));
  const acknowledged = new Set((source.notDrawn ?? []).map((entry) => entry.section.toLowerCase()));
  const drawn = new Uint8Array(read.instancePart.length);
  const kept: number[] = [];
  read.instancePart.forEach((key, i) => {
    if (acknowledged.has(read.parts[key] ?? "")) return;
    drawn[i] = 1;
    kept.push(i);
  });
  let differing = 0;
  for (let n = 0; n < Math.max(kept.length, bundled.instances.part.length); n++) {
    const i = kept[n] ?? -1;
    const key = read.parts[read.instancePart[i] ?? -1] ?? "";
    const samePart =
      bundlePartId(officialOf.get(key) ?? key) === bundled.parts[bundled.instances.part[n] ?? -1];
    const sameColor = read.instanceColor[i] === bundled.instances.color[n];
    let sameMatrix = true;
    for (let k = 0; k < MATRIX_FLOATS; k++) {
      const transform = read.instanceTransform[i * MATRIX_FLOATS + k] ?? Number.NaN;
      if (
        transform !== bundled.partTransforms[n * MATRIX_FLOATS + k] ||
        Math.fround(transform) !== bundled.instances.matrix[n * MATRIX_FLOATS + k]
      ) {
        sameMatrix = false;
      }
    }
    if (!samePart || !sameColor || !sameMatrix) differing++;
  }
  const started = performance.now();
  const request = {
    source: text,
    drawn,
    studPrimitives: standardManifest.studPrimitives.map((primitive) => primitive.name),
    unofficialAllowlist: standardManifest.compiler.unofficialAllowlist,
    translucentColors,
    vehicles: standardManifest.compiler.vehicles ?? null,
  };
  let baked = baker.bake(request, library);
  while (baked.status === "need") {
    for (const path of baked.paths) {
      if (files.has(path)) throw new Error(`bake asked for ${path}, which it was given`);
      library.absent.add(path);
    }
    baked = baker.bake(request, library);
  }
  const bakeMs = performance.now() - started;
  const mismatches: string[] = [];
  if (baked.status !== "baked") {
    mismatches.push(`bake ${baked.status}: ${baked.message}`);
  } else {
    const lattice =
      baked.lattice === null
        ? null
        : [
            baked.lattice.phaseX,
            baked.lattice.phaseZ,
            baked.lattice.aabbMin,
            baked.lattice.aabbMax,
          ];
    const expected = bundled.lattice as {
      readonly phase: readonly [number, number];
      readonly aabb: { readonly min: unknown; readonly max: unknown };
    } | null;
    const expectedLattice =
      expected === null
        ? null
        : [expected.phase[0], expected.phase[1], expected.aabb.min, expected.aabb.max];
    if (!isDeepStrictEqual(lattice, expectedLattice)) mismatches.push("lattice");
    if (baked.studCover.studs !== bundled.cover.studs) mismatches.push("cover studs");
    if (baked.studCover.covered !== bundled.cover.coveredStuds) mismatches.push("covered studs");
    if (!isDeepStrictEqual([...baked.studCover.visibleBits], bundled.cover.visibleBits)) {
      mismatches.push("visible-stud bits");
    }
    const cells = bundled.cover.cells;
    const bakedCells = baked.cells;
    if ((cells === null) !== (bakedCells === null)) mismatches.push("cells presence");
    if (cells && bakedCells) {
      if (!isDeepStrictEqual([bakedCells.originX, bakedCells.originZ], [...cells.origin]))
        mismatches.push("cell origin");
      if (!isDeepStrictEqual([bakedCells.width, bakedCells.depth], [...cells.size]))
        mismatches.push("cell grid size");
      if (bakedCells.restY !== cells.bottomY) mismatches.push("rest y");
      if (!isDeepStrictEqual([...bakedCells.footprint], cells.footprint))
        mismatches.push("footprint");
      if (!isDeepStrictEqual([...bakedCells.flat], cells.flat)) mismatches.push("flat cells");
      if (!isDeepStrictEqual([...bakedCells.columnBottom], cells.columnBottom))
        mismatches.push("column bottoms");
      if (!isDeepStrictEqual([...bakedCells.columnTop], cells.columnTop))
        mismatches.push("column tops");
    }
    const vehicles = baked.vehicles.map((vehicle) => ({
      ...vehicle,
      body: [...vehicle.body],
      bogies: vehicle.bogies.map((bogie) => ({ ...bogie, instances: [...bogie.instances] })),
    }));
    if (!isDeepStrictEqual(vehicles, bundled.vehicles)) mismatches.push("vehicles");
  }
  if (differing === 0 && mismatches.length === 0) bakesIdentical++;
  process.stdout.write(
    `bake ${model.name}: ${kept.length} instances, ${differing} differing (part, colour, float32 matrix); lattice, cover, cells and vehicles ${mismatches.length === 0 ? "identical" : `differ: ${mismatches.join(", ")}`} (WASM bake ${bakeMs.toFixed(0)} ms)\n`,
  );
  if (differing > 0 || mismatches.length > 0) process.exitCode = 1;
}
process.stdout.write(
  `bakes: ${bakesIdentical} of ${standardManifest.models.length} identical to the bundle\n`,
);
