import {
  BundleManifest,
  ModelFile,
  type BundleLod,
  type BundleModelEntry,
  type ManifestPart,
} from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";
import { MATRIX_FLOATS, readCompiledGlb, type CompiledGlb, type Mesh } from "./glb-mesh.ts";
import { encodePng } from "./png.ts";
import {
  INHERIT_COLOR,
  renderThumbnail,
  THUMBNAIL_PX,
  type Box,
  type ThumbnailScene,
} from "./rasterizer.ts";

export const THUMBNAIL_DIRECTORY = "thumb";
export const THUMBNAIL_LOD: BundleLod = "standard";
const MANIFEST_FILE = "manifest.json";
const CATALOG_ROLES: ReadonlySet<string> = new Set(["ground", "road"]);
const BITS_PER_WORD = 32;
const UNSAFE_FILE_CHARACTERS = /[^A-Za-z0-9._-]+/gu;

export interface CatalogThumbnail {
  readonly item: string;
  readonly file: string;
}

export interface RenderedThumbnail extends CatalogThumbnail {
  readonly bytes: number;
  readonly ms: number;
}

const ThumbnailInputs = v.pick(BundleManifest, ["parts", "studPrimitives", "colors", "models"]);
type ThumbnailInputs = v.InferOutput<typeof ThumbnailInputs>;

export function modelItemId(entry: Pick<BundleModelEntry, "name" | "role">): string {
  return entry.role === "mils-module" ? `generated:${entry.name}` : `omr:${entry.name}`;
}

export function isPlaceableModel(entry: Pick<BundleModelEntry, "origin" | "role">): boolean {
  return entry.role === "mils-module" || entry.origin === "omr";
}

export function thumbnailFile(item: string): string {
  return `${THUMBNAIL_DIRECTORY}/${item.replace(UNSAFE_FILE_CHARACTERS, "-")}.png`;
}

class SceneBuilder {
  readonly meshes: Mesh[] = [];
  private readonly meshIndex = new Map<Mesh, number>();
  private mesh: number[] = [];
  private color: number[] = [];
  private matrices: number[] = [];

  add(mesh: Mesh, color: number, matrix: Float32Array, offset: number): void {
    let index = this.meshIndex.get(mesh);
    if (index === undefined) {
      index = this.meshes.length;
      this.meshes.push(mesh);
      this.meshIndex.set(mesh, index);
    }
    this.mesh.push(index);
    this.color.push(color);
    for (let k = 0; k < MATRIX_FLOATS; k++) this.matrices.push(matrix[offset + k] ?? 0);
  }

  scene(box: Box): ThumbnailScene {
    return {
      meshes: this.meshes,
      count: this.mesh.length,
      mesh: Uint32Array.from(this.mesh),
      color: Uint16Array.from(this.color),
      matrices: Float32Array.from(this.matrices),
      box,
    };
  }
}

function compose(
  outer: Float32Array,
  o: number,
  inner: Float32Array,
  n: number,
  out: Float32Array,
): void {
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) {
      out[row * 4 + col] =
        (outer[o + row * 4] ?? 0) * (inner[n + col] ?? 0) +
        (outer[o + row * 4 + 1] ?? 0) * (inner[n + 4 + col] ?? 0) +
        (outer[o + row * 4 + 2] ?? 0) * (inner[n + 8 + col] ?? 0) +
        (col === 3 ? (outer[o + row * 4 + 3] ?? 0) : 0);
    }
  }
}

const IDENTITY = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0);

class CompiledBundle {
  private readonly glbs = new Map<string, CompiledGlb>();
  private readonly partsById: ReadonlyMap<string, ManifestPart>;
  private readonly studFiles: ReadonlyMap<string, string>;
  private readonly composed = new Float32Array(MATRIX_FLOATS);

  constructor(
    private readonly directory: string,
    readonly manifest: ThumbnailInputs,
  ) {
    this.partsById = new Map(manifest.parts.map((part) => [part.id, part]));
    this.studFiles = new Map(manifest.studPrimitives.map((stud) => [stud.name, stud.file]));
  }

  private async glb(file: string): Promise<CompiledGlb> {
    let glb = this.glbs.get(file);
    if (!glb) {
      glb = readCompiledGlb(new Uint8Array(await readFile(join(this.directory, file))), file);
      this.glbs.set(file, glb);
    }
    return glb;
  }

  private part(id: string): ManifestPart {
    const part = this.partsById.get(id);
    if (!part) throw new Error(`part ${id} is not in the compiled manifest`);
    return part;
  }

  private async studMesh(name: string, part: string): Promise<Mesh> {
    const file = this.studFiles.get(name);
    if (file === undefined) throw new Error(`${part}: unknown stud primitive ${name}`);
    return (await this.glb(file)).mesh;
  }

  private async addPart(
    builder: SceneBuilder,
    part: ManifestPart,
    color: number,
    matrices: Float32Array,
    offset: number,
    studVisible: (stud: number) => boolean,
  ): Promise<void> {
    const { mesh, studs } = await this.glb(part.file);
    builder.add(mesh, color, matrices, offset);
    for (let s = 0; s < studs.primitive.length; s++) {
      if (!studVisible(s)) continue;
      compose(matrices, offset, studs.matrices, s * MATRIX_FLOATS, this.composed);
      const studColor = studs.color[s] ?? INHERIT_COLOR;
      builder.add(
        await this.studMesh(studs.primitive[s] ?? "", part.id),
        studColor === INHERIT_COLOR ? color : studColor,
        this.composed,
        0,
      );
    }
  }

  async partScene(part: ManifestPart, color: number): Promise<ThumbnailScene> {
    const builder = new SceneBuilder();
    await this.addPart(builder, part, color, IDENTITY, 0, () => true);
    return builder.scene(part.bounds);
  }

  async modelScene(entry: BundleModelEntry): Promise<ThumbnailScene> {
    const path = join(this.directory, entry.file);
    const file = decodedOrThrow(decode(ModelFile, JSON.parse(await readFile(path, "utf8"))), path);
    if (file.lattice === null) throw new Error(`${entry.name} has no lattice to frame`);
    const parts = file.parts.map((id) => this.part(id));
    const matrices = Float32Array.from(file.instances.matrix);
    const visibleBits = Uint32Array.from(file.cover.visibleBits);
    const builder = new SceneBuilder();
    let firstStud = 0;
    for (let i = 0; i < file.instances.part.length; i++) {
      const part = parts[file.instances.part[i] ?? 0];
      if (!part) throw new Error(`${entry.file}: instance ${i} names a missing part`);
      const base = firstStud;
      await this.addPart(
        builder,
        part,
        file.instances.color[i] ?? INHERIT_COLOR,
        matrices,
        i * MATRIX_FLOATS,
        (s) => {
          const stud = base + s;
          return (((visibleBits[stud >>> 5] ?? 0) >>> (stud & (BITS_PER_WORD - 1))) & 1) === 1;
        },
      );
      firstStud += part.studs;
    }
    if (firstStud !== file.cover.studs) {
      throw new Error(
        `${entry.file}: the stud cover lists ${file.cover.studs} studs but its parts have ${firstStud}`,
      );
    }
    return builder.scene(file.lattice.aabb);
  }
}

export async function renderCatalogThumbnails(
  directory: string,
  manifestJson: unknown,
  clock: () => number,
): Promise<ReadonlyArray<RenderedThumbnail>> {
  const manifest = decodedOrThrow(decode(ThumbnailInputs, manifestJson), directory);
  const bundle = new CompiledBundle(directory, manifest);
  await mkdir(join(directory, THUMBNAIL_DIRECTORY), { recursive: true });
  const rendered: RenderedThumbnail[] = [];
  const files = new Map<string, string>();
  const write = async (item: string, scene: () => Promise<ThumbnailScene>) => {
    const file = thumbnailFile(item);
    const clash = files.get(file);
    if (clash !== undefined) throw new Error(`${item} and ${clash} share thumbnail ${file}`);
    files.set(file, item);
    const started = clock();
    const pixels = renderThumbnail(await scene(), manifest.colors);
    const png = encodePng(THUMBNAIL_PX, THUMBNAIL_PX, pixels);
    await writeFile(join(directory, file), png);
    rendered.push({ item, file, bytes: png.length, ms: clock() - started });
  };
  for (const part of manifest.parts) {
    if (!CATALOG_ROLES.has(part.role)) continue;
    const colors = part.producedColors?.colors ?? [];
    if (colors.length === 0) throw new Error(`${part.id} has no produced colour to render`);
    for (const { ldraw } of colors) {
      await write(`${part.id}@${ldraw}`, () => bundle.partScene(part, ldraw));
    }
  }
  for (const entry of manifest.models) {
    if (!isPlaceableModel(entry) || entry.lattice === null) continue;
    await write(modelItemId(entry), () => bundle.modelScene(entry));
  }
  return rendered;
}

export async function attachThumbnails(
  directory: string,
  lod: BundleLod,
  clock: () => number,
): Promise<ReadonlyArray<RenderedThumbnail>> {
  const manifestPath = join(directory, MANIFEST_FILE);
  const compiled: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  if (typeof compiled !== "object" || compiled === null) {
    throw new Error(`${manifestPath} is not a compiled bundle`);
  }
  const rendered =
    lod === THUMBNAIL_LOD ? await renderCatalogThumbnails(directory, compiled, clock) : [];
  const thumbnails = rendered.map(({ item, file }) => ({ item, file }));
  await writeFile(manifestPath, `${JSON.stringify({ ...compiled, thumbnails }, null, 2)}\n`);
  return rendered;
}
