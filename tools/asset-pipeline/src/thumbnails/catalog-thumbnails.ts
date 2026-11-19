import { parseGlb, readPartMesh } from "@brr/catalog/glb";
import {
  BundleIndexFields,
  ModelFile,
  type BundleLod,
  type BundleModelEntry,
  type StudRecord,
} from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";
import { encodePng } from "./png.ts";
import {
  INHERIT_COLOR,
  MATRIX_FLOATS,
  renderThumbnail,
  THUMBNAIL_PX,
  type Box,
  type Mesh,
  type ThumbnailScene,
} from "./rasterizer.ts";

export const THUMBNAIL_DIRECTORY = "thumb";
export const THUMBNAIL_LOD: BundleLod = "standard";
const MANIFEST_FILE = "manifest.json";
const THUMBNAIL_ROLES: ReadonlySet<string> = new Set(["ground", "road"]);
const BITS_PER_WORD = 32;
const UNSAFE_FILE_CHARACTERS = /[^A-Za-z0-9._-]+/gu;
const EMPTY_MESH: Mesh = {
  positions: new Float32Array(0),
  normals: new Float32Array(0),
  groups: [],
};
const IDENTITY = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0);

export interface CatalogThumbnail {
  readonly item: string;
  readonly file: string;
}

export interface RenderedThumbnail extends CatalogThumbnail {
  readonly bytes: number;
  readonly ms: number;
}

interface CompiledPart {
  readonly mesh: Mesh;
  readonly studs: ReadonlyArray<StudRecord>;
}

const ThumbnailInputs = v.pick(BundleIndexFields, [
  "catalogParts",
  "studPrimitives",
  "colors",
  "models",
]);
type ThumbnailInputs = v.InferOutput<typeof ThumbnailInputs>;

export function thumbnailFile(item: string): string {
  return `${THUMBNAIL_DIRECTORY}/${item.replace(UNSAFE_FILE_CHARACTERS, "-")}.png`;
}

class SceneBuilder {
  private readonly meshes: Mesh[] = [];
  private readonly meshIndex = new Map<Mesh, number>();
  private readonly mesh: number[] = [];
  private readonly color: number[] = [];
  private readonly matrices: number[] = [];

  add(mesh: Mesh, color: number, matrix: ArrayLike<number>, offset: number): void {
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
  outer: ArrayLike<number>,
  o: number,
  inner: ArrayLike<number>,
  out: Float32Array,
): void {
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) {
      out[row * 4 + col] =
        (outer[o + row * 4] ?? 0) * (inner[col] ?? 0) +
        (outer[o + row * 4 + 1] ?? 0) * (inner[4 + col] ?? 0) +
        (outer[o + row * 4 + 2] ?? 0) * (inner[8 + col] ?? 0) +
        (col === 3 ? (outer[o + row * 4 + 3] ?? 0) : 0);
    }
  }
}

function arrayBuffer(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

class CompiledBundle {
  private readonly parts = new Map<string, CompiledPart>();
  private readonly studFiles: ReadonlyMap<string, string>;
  private readonly composed = new Float32Array(MATRIX_FLOATS);
  private readonly directory: string;

  constructor(directory: string, manifest: ThumbnailInputs) {
    this.directory = directory;
    this.studFiles = new Map(manifest.studPrimitives.map((stud) => [stud.name, stud.file]));
  }

  private async part(file: string): Promise<CompiledPart> {
    let part = this.parts.get(file);
    if (!part) {
      const glb = parseGlb(arrayBuffer(await readFile(join(this.directory, file))), file);
      const empty = (glb.document.meshes[0]?.primitives.length ?? 0) === 0;
      part = {
        mesh: empty ? EMPTY_MESH : readPartMesh(glb, file),
        studs: glb.document.extras.studs,
      };
      this.parts.set(file, part);
    }
    return part;
  }

  private async studMesh(name: string, owner: string): Promise<Mesh> {
    const file = this.studFiles.get(name);
    if (file === undefined) throw new Error(`${owner}: unknown stud primitive ${name}`);
    return (await this.part(file)).mesh;
  }

  private async addPart(
    builder: SceneBuilder,
    file: string,
    color: number,
    matrices: ArrayLike<number>,
    offset: number,
    studVisible: (stud: number) => boolean,
  ): Promise<number> {
    const { mesh, studs } = await this.part(file);
    builder.add(mesh, color, matrices, offset);
    for (let s = 0; s < studs.length; s++) {
      const stud = studs[s];
      if (!stud || !studVisible(s)) continue;
      compose(matrices, offset, stud.matrix, this.composed);
      builder.add(
        await this.studMesh(stud.primitive, file),
        stud.color === INHERIT_COLOR ? color : stud.color,
        this.composed,
        0,
      );
    }
    return studs.length;
  }

  async partScene(file: string, color: number, box: Box): Promise<ThumbnailScene> {
    const builder = new SceneBuilder();
    await this.addPart(builder, file, color, IDENTITY, 0, () => true);
    return builder.scene(box);
  }

  async modelScene(entry: BundleModelEntry): Promise<ThumbnailScene> {
    const path = join(this.directory, entry.file);
    const file = decodedOrThrow(decode(ModelFile, JSON.parse(await readFile(path, "utf8"))), path);
    if (file.lattice === null) throw new Error(`${entry.name} has no lattice to frame`);
    const visibleBits = Uint32Array.from(file.cover.visibleBits);
    const visible = (stud: number) =>
      (((visibleBits[stud >>> 5] ?? 0) >>> (stud & (BITS_PER_WORD - 1))) & 1) === 1;
    const builder = new SceneBuilder();
    let firstStud = 0;
    for (let i = 0; i < file.instances.part.length; i++) {
      const shape = file.shapes[file.instances.part[i] ?? 0];
      if (!shape) throw new Error(`${entry.file}: instance ${i} names a missing part`);
      const base = firstStud;
      firstStud += await this.addPart(
        builder,
        shape.file,
        file.instances.color[i] ?? INHERIT_COLOR,
        file.instances.matrix,
        i * MATRIX_FLOATS,
        (s) => visible(base + s),
      );
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
  for (const part of manifest.catalogParts) {
    if (!THUMBNAIL_ROLES.has(part.role)) continue;
    const colors = part.producedColors?.colors ?? [];
    if (colors.length === 0) throw new Error(`${part.id} has no produced colour to render`);
    for (const { ldraw } of colors) {
      await write(`${part.id}@${ldraw}`, () => bundle.partScene(part.file, ldraw, part.bounds));
    }
  }
  for (const entry of manifest.models) {
    if (entry.lattice === null) continue;
    await write(`${entry.origin}:${entry.name}`, () => bundle.modelScene(entry));
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
