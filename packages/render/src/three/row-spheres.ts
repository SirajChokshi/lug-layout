import type { BufferGeometry, Sphere } from "three/webgpu";
import { MATRIX4_FLOATS, TRANSLATION_FLOATS, type InstancePage } from "./instance-page.ts";
import { MESH_KIND_STUD } from "./mesh-page.ts";

export const NO_MATCH = -1;
const SPHERE_DOUBLES = 4;
const SPHERES_PER_ROW = 2;

export interface SphereReuse {
  readonly replaced: RowSpheres | undefined;
  readonly built: RowSpheres;
}

interface PageBits {
  readonly matrices: Uint32Array;
  readonly studTranslations: Uint32Array;
}

function bitsOf(values: Float32Array): Uint32Array {
  return new Uint32Array(values.buffer, values.byteOffset, values.length);
}

function sameWords(
  a: Uint32Array,
  aFrom: number,
  b: Uint32Array,
  bFrom: number,
  words: number,
): boolean {
  for (let i = 0; i < words; i++) {
    if (a[aFrom + i] !== b[bFrom + i]) return false;
  }
  return true;
}

export class RowSpheres {
  private readonly sources: Array<BufferGeometry | null>;
  private readonly kinds: Uint8Array;
  private readonly starts: Uint32Array;
  private readonly counts: Uint32Array;
  private readonly spheres: Float64Array;
  private size = 0;
  private cursor = 0;
  private bits: PageBits | null = null;

  constructor(
    readonly page: InstancePage,
    rows: number,
  ) {
    const capacity = rows * SPHERES_PER_ROW;
    this.sources = Array.from({ length: capacity }, (): BufferGeometry | null => null);
    this.kinds = new Uint8Array(capacity);
    this.starts = new Uint32Array(capacity);
    this.counts = new Uint32Array(capacity);
    this.spheres = new Float64Array(capacity * SPHERE_DOUBLES);
  }

  match(
    built: RowSpheres,
    source: BufferGeometry,
    kind: number,
    start: number,
    count: number,
  ): number {
    for (let step = 0; step < this.size; step++) {
      const index = (this.cursor + step) % this.size;
      if (
        this.sources[index] !== source ||
        this.kinds[index] !== kind ||
        this.counts[index] !== count ||
        !this.sameInstances(index, built, start)
      ) {
        continue;
      }
      this.cursor = index + 1;
      return index;
    }
    return NO_MATCH;
  }

  append(source: BufferGeometry, kind: number, start: number, count: number, sphere: Sphere): void {
    const index = this.size;
    if (index === this.counts.length) {
      throw new Error("a chunk computed more bounding spheres than two per mesh row");
    }
    this.size++;
    this.sources[index] = source;
    this.kinds[index] = kind;
    this.starts[index] = start;
    this.counts[index] = count;
    const at = index * SPHERE_DOUBLES;
    this.spheres[at] = sphere.center.x;
    this.spheres[at + 1] = sphere.center.y;
    this.spheres[at + 2] = sphere.center.z;
    this.spheres[at + 3] = sphere.radius;
  }

  copyTo(index: number, sphere: Sphere): void {
    const at = index * SPHERE_DOUBLES;
    sphere.center.set(this.spheres[at] ?? 0, this.spheres[at + 1] ?? 0, this.spheres[at + 2] ?? 0);
    sphere.radius = this.spheres[at + 3] ?? 0;
  }

  private sameInstances(index: number, built: RowSpheres, start: number): boolean {
    const from = this.starts[index] ?? 0;
    if (built.page === this.page && from === start) return true;
    const count = this.counts[index] ?? 0;
    if (this.kinds[index] === MESH_KIND_STUD) {
      const mine = from - this.page.partCount;
      const theirs = start - built.page.partCount;
      return (
        sameWords(
          this.pageBits().studTranslations,
          mine * TRANSLATION_FLOATS,
          built.pageBits().studTranslations,
          theirs * TRANSLATION_FLOATS,
          count * TRANSLATION_FLOATS,
        ) &&
        sameWords(
          this.page.studBasisAndColorIndex,
          mine,
          built.page.studBasisAndColorIndex,
          theirs,
          count,
        )
      );
    }
    return sameWords(
      this.pageBits().matrices,
      from * MATRIX4_FLOATS,
      built.pageBits().matrices,
      start * MATRIX4_FLOATS,
      count * MATRIX4_FLOATS,
    );
  }

  private pageBits(): PageBits {
    this.bits ??= {
      matrices: bitsOf(this.page.matrices),
      studTranslations: bitsOf(this.page.studTranslations),
    };
    return this.bits;
  }
}
