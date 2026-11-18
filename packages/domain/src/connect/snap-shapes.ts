export const SECTION_ROUND = 0;
export const SECTION_AXLE = 1;
export const SECTION_SQUARE = 2;
export const CAP_ROOT = 1;
export const CAP_FAR = 2;
const INITIAL_SHAPES = 16;
const INITIAL_SECTIONS = 64;

export class SnapShapes {
  private shapes = 0;
  private sections = 0;
  private capsOf = new Uint8Array(INITIAL_SHAPES);
  private slideOf = new Uint8Array(INITIAL_SHAPES);
  private firstOf = new Int32Array(INITIAL_SHAPES);
  private countOf = new Int32Array(INITIAL_SHAPES);
  private lengthOf = new Float64Array(INITIAL_SHAPES);
  private codeOf = new Uint8Array(INITIAL_SECTIONS);
  private sizeOf = new Float32Array(INITIAL_SECTIONS);
  private spanOf = new Float32Array(INITIAL_SECTIONS);
  private readonly ids = new Map<string, number>();

  get count(): number {
    return this.shapes;
  }

  intern(
    caps: number,
    slide: boolean,
    codes: ArrayLike<number>,
    sizes: ArrayLike<number>,
    lengths: ArrayLike<number>,
  ): number {
    const n = codes.length;
    if (n === 0 || sizes.length !== n || lengths.length !== n) {
      throw new RangeError(`a snap shape needs one size and length per section, got ${n} sections`);
    }
    const key = shapeKey(caps, slide, codes, sizes, lengths);
    const existing = this.ids.get(key);
    if (existing !== undefined) return existing;
    if (this.shapes === this.capsOf.length) this.growShapes();
    while (this.sections + n > this.codeOf.length) this.growSections();
    const shape = this.shapes++;
    this.capsOf[shape] = caps;
    this.slideOf[shape] = slide ? 1 : 0;
    this.firstOf[shape] = this.sections;
    this.countOf[shape] = n;
    let length = 0;
    for (let s = 0; s < n; s++) {
      const span = lengths[s] ?? 0;
      if (!(span > 0)) throw new RangeError(`snap section ${s} has length ${span}`);
      this.codeOf[this.sections] = codes[s] ?? 0;
      this.sizeOf[this.sections] = sizes[s] ?? 0;
      this.spanOf[this.sections] = span;
      length += this.spanOf[this.sections] ?? 0;
      this.sections++;
    }
    this.lengthOf[shape] = length;
    this.ids.set(key, shape);
    return shape;
  }

  caps(shape: number): number {
    return this.capsOf[shape] ?? 0;
  }

  slides(shape: number): boolean {
    return this.slideOf[shape] === 1;
  }

  length(shape: number): number {
    return this.lengthOf[shape] ?? 0;
  }

  firstSection(shape: number): number {
    return this.firstOf[shape] ?? 0;
  }

  sectionCount(shape: number): number {
    return this.countOf[shape] ?? 0;
  }

  code(section: number): number {
    return this.codeOf[section] ?? 0;
  }

  size(section: number): number {
    return this.sizeOf[section] ?? 0;
  }

  span(section: number): number {
    return this.spanOf[section] ?? 0;
  }

  private growShapes(): void {
    const capacity = this.capsOf.length * 2;
    this.capsOf = copied(this.capsOf, new Uint8Array(capacity));
    this.slideOf = copied(this.slideOf, new Uint8Array(capacity));
    this.firstOf = copied(this.firstOf, new Int32Array(capacity));
    this.countOf = copied(this.countOf, new Int32Array(capacity));
    this.lengthOf = copied(this.lengthOf, new Float64Array(capacity));
  }

  private growSections(): void {
    const capacity = this.codeOf.length * 2;
    this.codeOf = copied(this.codeOf, new Uint8Array(capacity));
    this.sizeOf = copied(this.sizeOf, new Float32Array(capacity));
    this.spanOf = copied(this.spanOf, new Float32Array(capacity));
  }
}

function shapeKey(
  caps: number,
  slide: boolean,
  codes: ArrayLike<number>,
  sizes: ArrayLike<number>,
  lengths: ArrayLike<number>,
): string {
  const parts = [String(caps), slide ? "slide" : "fixed"];
  for (let s = 0; s < codes.length; s++) {
    parts.push(`${codes[s]}:${Math.fround(sizes[s] ?? 0)}:${Math.fround(lengths[s] ?? 0)}`);
  }
  return parts.join("|");
}

function copied<T extends Uint8Array | Int32Array | Float32Array | Float64Array>(
  from: T,
  to: T,
): T {
  to.set(from);
  return to;
}
