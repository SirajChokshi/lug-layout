export const SECTION_ROUND = 0;
export const SECTION_AXLE = 1;
export const SECTION_SQUARE = 2;
export const SECTION_FLARE_JOINS_PREVIOUS = 3;
export const SECTION_FLARE_JOINS_NEXT = 4;
export const CAP_ROOT = 1;
export const CAP_FAR = 2;
export const NO_GROUP = "";
const INITIAL_SHAPES = 16;
const INITIAL_SECTIONS = 64;

export class SnapShapes {
  private shapes = 0;
  private sections = 0;
  private longestLength = 0;
  private capsOf = new Uint8Array(INITIAL_SHAPES);
  private slideOf = new Uint8Array(INITIAL_SHAPES);
  private firstOf = new Int32Array(INITIAL_SHAPES);
  private countOf = new Int32Array(INITIAL_SHAPES);
  private lengthOf = new Float64Array(INITIAL_SHAPES);
  private groupOf = new Int32Array(INITIAL_SHAPES);
  private codeOf = new Uint8Array(INITIAL_SECTIONS);
  private sizeOf = new Float32Array(INITIAL_SECTIONS);
  private spanOf = new Float32Array(INITIAL_SECTIONS);
  private maleCodeOf = new Uint8Array(INITIAL_SECTIONS);
  private maleSizeOf = new Float32Array(INITIAL_SECTIONS);
  private femaleCodeOf = new Uint8Array(INITIAL_SECTIONS);
  private femaleSizeOf = new Float32Array(INITIAL_SECTIONS);
  private readonly ids = new Map<string, number>();
  private readonly groups = new Map<string, number>([[NO_GROUP, 0]]);

  get count(): number {
    return this.shapes;
  }

  get longest(): number {
    return this.longestLength;
  }

  intern(
    caps: number,
    slide: boolean,
    codes: ArrayLike<number>,
    sizes: ArrayLike<number>,
    lengths: ArrayLike<number>,
    group: string = NO_GROUP,
  ): number {
    const n = codes.length;
    if (n === 0 || sizes.length !== n || lengths.length !== n) {
      throw new RangeError(`a snap shape needs one size and length per section, got ${n} sections`);
    }
    const key = shapeKey(caps, slide, codes, sizes, lengths, group);
    const existing = this.ids.get(key);
    if (existing !== undefined) return existing;
    if (this.shapes === this.capsOf.length) this.growShapes();
    while (this.sections + n > this.codeOf.length) this.growSections();
    const shape = this.shapes++;
    this.capsOf[shape] = caps;
    this.slideOf[shape] = slide ? 1 : 0;
    this.groupOf[shape] = this.groupToken(group);
    this.firstOf[shape] = this.sections;
    this.countOf[shape] = n;
    let length = 0;
    for (let s = 0; s < n; s++) {
      const span = lengths[s] ?? 0;
      if (!(span >= 0) || !Number.isFinite(span)) {
        throw new RangeError(`snap section ${s} has length ${span}`);
      }
      this.codeOf[this.sections] = codes[s] ?? 0;
      this.sizeOf[this.sections] = sizes[s] ?? 0;
      this.spanOf[this.sections] = span;
      length += this.spanOf[this.sections] ?? 0;
      this.sections++;
    }
    this.readRoles(this.firstOf[shape] ?? 0, n);
    this.lengthOf[shape] = length;
    this.longestLength = Math.max(this.longestLength, length);
    this.ids.set(key, shape);
    return shape;
  }

  caps(shape: number): number {
    return this.capsOf[shape] ?? 0;
  }

  group(shape: number): number {
    return this.groupOf[shape] ?? 0;
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

  span(section: number): number {
    return this.spanOf[section] ?? 0;
  }

  maleCode(section: number): number {
    return this.maleCodeOf[section] ?? 0;
  }

  maleSize(section: number): number {
    return this.maleSizeOf[section] ?? 0;
  }

  femaleCode(section: number): number {
    return this.femaleCodeOf[section] ?? 0;
  }

  femaleSize(section: number): number {
    return this.femaleSizeOf[section] ?? 0;
  }

  private readRoles(first: number, count: number): void {
    for (let s = first; s < first + count; s++) {
      const code = this.codeOf[s] ?? 0;
      const size = this.sizeOf[s] ?? 0;
      const partner = flarePartner(code, s, first, count);
      const flare = partner !== NOT_A_FLARE;
      const seated = flare && partner !== NO_PARTNER && this.codeOf[partner] === SECTION_ROUND;
      this.maleCodeOf[s] = seated ? SECTION_ROUND : code;
      this.maleSizeOf[s] = seated ? (this.sizeOf[partner] ?? 0) : size;
      this.femaleCodeOf[s] = flare ? SECTION_ROUND : code;
      this.femaleSizeOf[s] = size;
    }
  }

  private groupToken(group: string): number {
    let token = this.groups.get(group);
    if (token === undefined) {
      token = this.groups.size;
      this.groups.set(group, token);
    }
    return token;
  }

  private growShapes(): void {
    const capacity = this.capsOf.length * 2;
    this.capsOf = copied(this.capsOf, new Uint8Array(capacity));
    this.slideOf = copied(this.slideOf, new Uint8Array(capacity));
    this.firstOf = copied(this.firstOf, new Int32Array(capacity));
    this.countOf = copied(this.countOf, new Int32Array(capacity));
    this.lengthOf = copied(this.lengthOf, new Float64Array(capacity));
    this.groupOf = copied(this.groupOf, new Int32Array(capacity));
  }

  private growSections(): void {
    const capacity = this.codeOf.length * 2;
    this.codeOf = copied(this.codeOf, new Uint8Array(capacity));
    this.sizeOf = copied(this.sizeOf, new Float32Array(capacity));
    this.spanOf = copied(this.spanOf, new Float32Array(capacity));
    this.maleCodeOf = copied(this.maleCodeOf, new Uint8Array(capacity));
    this.maleSizeOf = copied(this.maleSizeOf, new Float32Array(capacity));
    this.femaleCodeOf = copied(this.femaleCodeOf, new Uint8Array(capacity));
    this.femaleSizeOf = copied(this.femaleSizeOf, new Float32Array(capacity));
  }
}

const NOT_A_FLARE = -2;
const NO_PARTNER = -1;

function flarePartner(code: number, section: number, first: number, count: number): number {
  const neighbour =
    code === SECTION_FLARE_JOINS_PREVIOUS
      ? section - 1
      : code === SECTION_FLARE_JOINS_NEXT
        ? section + 1
        : NOT_A_FLARE;
  if (neighbour === NOT_A_FLARE) return NOT_A_FLARE;
  return neighbour >= first && neighbour < first + count ? neighbour : NO_PARTNER;
}

function shapeKey(
  caps: number,
  slide: boolean,
  codes: ArrayLike<number>,
  sizes: ArrayLike<number>,
  lengths: ArrayLike<number>,
  group: string,
): string {
  const parts = [String(caps), slide ? "slide" : "fixed", JSON.stringify(group)];
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
