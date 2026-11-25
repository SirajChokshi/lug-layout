export const SECTION_ROUND = 0;
export const SECTION_AXLE = 1;
export const SECTION_SQUARE = 2;
export const SECTION_FLARE_JOINS_PREVIOUS = 3;
export const SECTION_FLARE_JOINS_NEXT = 4;
export const SECTION_MALE_FINGER = 5;
export const SECTION_FEMALE_FINGER = 6;
export const FINGER_RADIUS_UNSTATED = 0;
export const CAP_ROOT = 1;
export const CAP_FAR = 2;
export const NO_GROUP = "";
const NO_GROUP_TOKEN = 0;
const INITIAL_SHAPES = 16;
const INITIAL_SECTIONS = 64;

export class SnapShapes {
  private shapes = 0;
  private sections = 0;
  private longestLength = 0;
  private foundSectionEnd = 0;
  private capsOf = new Uint8Array(INITIAL_SHAPES);
  private slideOf = new Uint8Array(INITIAL_SHAPES);
  private firstOf = new Int32Array(INITIAL_SHAPES);
  private countOf = new Int32Array(INITIAL_SHAPES);
  private lengthOf = new Float64Array(INITIAL_SHAPES);
  private groupOf = new Int32Array(INITIAL_SHAPES);
  private codeOf = new Uint8Array(INITIAL_SECTIONS);
  private sizeOf = new Float64Array(INITIAL_SECTIONS);
  private spanOf = new Float64Array(INITIAL_SECTIONS);
  private maleCodeOf = new Uint8Array(INITIAL_SECTIONS);
  private maleSizeOf = new Float64Array(INITIAL_SECTIONS);
  private femaleCodeOf = new Uint8Array(INITIAL_SECTIONS);
  private femaleSizeOf = new Float64Array(INITIAL_SECTIONS);
  private readonly ids = new Map<string, number>();
  private readonly groups = new Map<string, number>([[NO_GROUP, NO_GROUP_TOKEN]]);
  private readonly groupNames: string[] = [NO_GROUP];

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

  clipped(shape: number, from: number, to: number, closes: number): number {
    const codes: number[] = [];
    const sizes: number[] = [];
    const lengths: number[] = [];
    let at = 0;
    const first = this.firstSection(shape);
    for (let s = first; s < first + this.sectionCount(shape); s++) {
      const end = at + this.span(s);
      const kept = Math.min(end, to) - Math.max(at, from);
      if (kept > 0) {
        codes.push(this.codeOf[s] ?? 0);
        sizes.push(this.sizeOf[s] ?? 0);
        lengths.push(kept);
      }
      at = end;
    }
    return this.intern(
      this.caps(shape) | closes,
      this.slides(shape),
      codes,
      sizes,
      lengths,
      this.groupName(shape),
    );
  }

  sameSectionsOver(a: number, aFrom: number, b: number, bFrom: number, length: number): boolean {
    if (this.group(a) !== this.group(b)) return false;
    let at = 0;
    while (at < length) {
      const sa = this.sectionAt(a, aFrom + at);
      const aEnd = this.foundSectionEnd - aFrom;
      const sb = this.sectionAt(b, bFrom + at);
      const bEnd = this.foundSectionEnd - bFrom;
      if (sa === NO_SECTION || sb === NO_SECTION) return true;
      if (this.codeOf[sa] !== this.codeOf[sb] || this.sizeOf[sa] !== this.sizeOf[sb]) return false;
      const next = Math.min(aEnd, bEnd, length);
      if (!(next > at)) return false;
      at = next;
    }
    return true;
  }

  compare(a: number, b: number): number {
    if (a === b) return 0;
    const count = this.sectionCount(a);
    const byHead =
      this.caps(a) - this.caps(b) ||
      (this.slideOf[a] ?? 0) - (this.slideOf[b] ?? 0) ||
      count - this.sectionCount(b);
    if (byHead !== 0) return byHead;
    const firstA = this.firstSection(a);
    const firstB = this.firstSection(b);
    for (let s = 0; s < count; s++) {
      const bySection =
        (this.codeOf[firstA + s] ?? 0) - (this.codeOf[firstB + s] ?? 0) ||
        Math.sign((this.sizeOf[firstA + s] ?? 0) - (this.sizeOf[firstB + s] ?? 0)) ||
        Math.sign((this.spanOf[firstA + s] ?? 0) - (this.spanOf[firstB + s] ?? 0));
      if (bySection !== 0) return bySection;
    }
    const groupA = this.groupName(a);
    const groupB = this.groupName(b);
    return groupA < groupB ? -1 : groupA > groupB ? 1 : 0;
  }

  groupName(shape: number): string {
    return this.groupNames[this.group(shape)] ?? NO_GROUP;
  }

  caps(shape: number): number {
    return this.capsOf[shape] ?? 0;
  }

  group(shape: number): number {
    return this.groupOf[shape] ?? NO_GROUP_TOKEN;
  }

  grouped(shape: number): boolean {
    return this.group(shape) !== NO_GROUP_TOKEN;
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

  internedCode(section: number): number {
    return this.codeOf[section] ?? 0;
  }

  internedSize(section: number): number {
    return this.sizeOf[section] ?? 0;
  }

  maleCode(section: number): number {
    return this.maleCodeOf[section] ?? 0;
  }

  maleSize(section: number): number {
    return this.maleSizeOf[section] ?? 0;
  }

  maleRelaxedSize(section: number): number {
    return this.sizeOf[section] ?? 0;
  }

  femaleCode(section: number): number {
    return this.femaleCodeOf[section] ?? 0;
  }

  femaleSize(section: number): number {
    return this.femaleSizeOf[section] ?? 0;
  }

  private sectionAt(shape: number, at: number): number {
    let end = 0;
    const first = this.firstSection(shape);
    for (let s = first; s < first + this.sectionCount(shape); s++) {
      end += this.span(s);
      if (at < end) {
        this.foundSectionEnd = end;
        return s;
      }
    }
    return NO_SECTION;
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
      this.groupNames.push(group);
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
    this.sizeOf = copied(this.sizeOf, new Float64Array(capacity));
    this.spanOf = copied(this.spanOf, new Float64Array(capacity));
    this.maleCodeOf = copied(this.maleCodeOf, new Uint8Array(capacity));
    this.maleSizeOf = copied(this.maleSizeOf, new Float64Array(capacity));
    this.femaleCodeOf = copied(this.femaleCodeOf, new Uint8Array(capacity));
    this.femaleSizeOf = copied(this.femaleSizeOf, new Float64Array(capacity));
  }
}

const NOT_A_FLARE = -2;
const NO_PARTNER = -1;
const NO_SECTION = -1;

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
    parts.push(`${codes[s]}:${sizes[s] ?? 0}:${lengths[s] ?? 0}`);
  }
  return parts.join("|");
}

function copied<T extends Uint8Array | Int32Array | Float64Array>(from: T, to: T): T {
  to.set(from);
  return to;
}
