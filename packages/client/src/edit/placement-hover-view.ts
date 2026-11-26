import {
  GENDER_MALE,
  NO_PARTNER,
  NO_SHAPE,
  SECTION_AXLE,
  SECTION_FEMALE_FINGER,
  SECTION_FLARE_JOINS_NEXT,
  SECTION_FLARE_JOINS_PREVIOUS,
  SECTION_MALE_FINGER,
  SECTION_ROUND,
  SECTION_SQUARE,
  SOURCE_INFERRED,
  STATUS_UNVERIFIED,
  type MateReport,
  type SnapShapes,
} from "@brr/domain";
import type {
  ConnectorKindView,
  ConnectorSectionView,
  HoverMateCount,
  HoverRefusalHit,
  PlacedModelView,
  SectionProfile,
} from "./placement-hover.ts";

function sectionProfile(code: number): SectionProfile {
  switch (code) {
    case SECTION_ROUND:
      return "round";
    case SECTION_AXLE:
      return "axle";
    case SECTION_SQUARE:
      return "square";
    case SECTION_FLARE_JOINS_PREVIOUS:
    case SECTION_FLARE_JOINS_NEXT:
      return "flare";
    case SECTION_MALE_FINGER:
    case SECTION_FEMALE_FINGER:
      return "finger";
    default:
      throw new RangeError(`snap section code ${code} has no profile`);
  }
}

export function connectorKind(
  shapes: SnapShapes,
  shape: number,
  gender: number,
  studShapes: Pick<ReadonlySet<number>, "has">,
): ConnectorKindView {
  const male = gender === GENDER_MALE;
  const first = shapes.firstSection(shape);
  const sections: ConnectorSectionView[] = [];
  for (let s = first; s < first + shapes.sectionCount(shape); s++) {
    sections.push({
      profile: sectionProfile(shapes.internedCode(s)),
      sizeLdu: shapes.internedSize(s),
      lengthLdu: shapes.span(s),
    });
  }
  return {
    gender: male ? "male" : "female",
    slides: shapes.slides(shape),
    stud: male && studShapes.has(shape),
    sections,
  };
}

interface MateTally {
  readonly kind: ConnectorKindView;
  readonly partnerKinds: Map<number, ConnectorKindView>;
  connectors: number;
  readonly joints: Set<number>;
  readonly partners: Map<number, PlacedModelView>;
  inferred: number;
  unverified: number;
}

type PlacedView = (owner: number) => PlacedModelView | null;

const INITIAL_ROWS = 64;
const UNLABELLED = -1;
const INSERTION_RUN = 16;
const DIGIT_BITS = 8;
const DIGITS = 1 << DIGIT_BITS;
const DIGIT_MASK = DIGITS - 1;
const KEY_BITS = 32;

class CanonicalRows {
  order = new Int32Array(INITIAL_ROWS);
  label = new Int32Array(INITIAL_ROWS);
  views: Array<PlacedModelView | null> = Array.from({ length: INITIAL_ROWS }, () => null);
  private merged = new Int32Array(INITIAL_ROWS);
  private family = new Int32Array(INITIAL_ROWS);
  private connector = new Int32Array(INITIAL_ROWS);
  private readonly counts = new Int32Array(DIGITS);

  sort(report: MateReport, shapes: SnapShapes, placedView: PlacedView): void {
    const n = report.count;
    if (this.order.length < n) {
      this.order = new Int32Array(Math.max(n, this.order.length * 2));
      this.merged = new Int32Array(this.order.length);
      this.family = new Int32Array(this.order.length);
      this.connector = new Int32Array(this.order.length);
      this.views = Array.from({ length: this.order.length }, () => null);
    }
    const { family, connector, partner, shape } = report;
    let lowest = 0;
    let highest = 0;
    for (let k = 0; k < n; k++) {
      const own = connector[k] ?? 0;
      lowest = k === 0 ? own : Math.min(lowest, own);
      highest = k === 0 ? own : Math.max(highest, own);
      this.order[k] = k;
      this.family[k] = family[k] ?? 0;
      const owner = partner[k] ?? NO_PARTNER;
      const shaped = (shape[k] ?? NO_SHAPE) !== NO_SHAPE;
      this.views[k] = shaped && owner !== NO_PARTNER ? placedView(owner) : null;
    }
    for (let k = 0; k < n; k++) this.connector[k] = (connector[k] ?? 0) - lowest;
    const spread = highest - lowest;
    for (
      let shift = 0;
      shift < KEY_BITS && Math.floor(spread / 2 ** shift) > 0;
      shift += DIGIT_BITS
    ) {
      this.distribute(this.connector, shift, n);
    }
    this.distribute(this.family, 0, n);
    this.orderTies(report, shapes, n);
    this.relabel(report);
  }

  private distribute(keys: Int32Array, shift: number, n: number): void {
    const counts = this.counts;
    const from = this.order;
    const into = this.merged;
    counts.fill(0);
    for (let i = 0; i < n; i++) {
      const digit = ((keys[from[i] ?? 0] ?? 0) >>> shift) & DIGIT_MASK;
      counts[digit] = (counts[digit] ?? 0) + 1;
    }
    let start = 0;
    for (let digit = 0; digit < DIGITS; digit++) {
      const count = counts[digit] ?? 0;
      counts[digit] = start;
      start += count;
    }
    for (let i = 0; i < n; i++) {
      const row = from[i] ?? 0;
      const digit = ((keys[row] ?? 0) >>> shift) & DIGIT_MASK;
      const at = counts[digit] ?? 0;
      into[at] = row;
      counts[digit] = at + 1;
    }
    this.order = into;
    this.merged = from;
  }

  private orderTies(report: MateReport, shapes: SnapShapes, n: number): void {
    let start = 0;
    for (let i = 1; i <= n; i++) {
      if (i < n && this.sameHead(this.order[i] ?? 0, this.order[start] ?? 0)) continue;
      if (i - start <= INSERTION_RUN) this.insertionSort(report, shapes, start, i);
      else this.mergeSort(report, shapes, start, i);
      start = i;
    }
  }

  private sameHead(a: number, b: number): boolean {
    return this.family[a] === this.family[b] && this.connector[a] === this.connector[b];
  }

  private insertionSort(report: MateReport, shapes: SnapShapes, lo: number, hi: number): void {
    const order = this.order;
    for (let i = lo + 1; i < hi; i++) {
      const row = order[i] ?? 0;
      let j = i;
      while (j > lo && this.compareTies(report, shapes, row, order[j - 1] ?? 0) < 0) {
        order[j] = order[j - 1] ?? 0;
        j--;
      }
      order[j] = row;
    }
  }

  private mergeSort(report: MateReport, shapes: SnapShapes, lo: number, hi: number): void {
    for (let run = lo; run < hi; run += INSERTION_RUN) {
      this.insertionSort(report, shapes, run, Math.min(run + INSERTION_RUN, hi));
    }
    const order = this.order;
    const merged = this.merged;
    for (let width = INSERTION_RUN; width < hi - lo; width *= 2) {
      for (let left = lo; left < hi; left += 2 * width) {
        const mid = Math.min(left + width, hi);
        const end = Math.min(left + 2 * width, hi);
        let a = left;
        let b = mid;
        let at = left;
        while (a < mid && b < end) {
          const fromA = order[a] ?? 0;
          const fromB = order[b] ?? 0;
          if (this.compareTies(report, shapes, fromB, fromA) < 0) {
            merged[at++] = fromB;
            b++;
          } else {
            merged[at++] = fromA;
            a++;
          }
        }
        while (a < mid) merged[at++] = order[a++] ?? 0;
        while (b < end) merged[at++] = order[b++] ?? 0;
      }
      for (let i = lo; i < hi; i++) order[i] = merged[i] ?? 0;
    }
  }

  private relabel(report: MateReport): void {
    const joints = report.jointCount;
    if (this.label.length < joints)
      this.label = new Int32Array(Math.max(joints, this.label.length * 2));
    this.label.fill(UNLABELLED, 0, joints);
    let next = 0;
    for (let i = 0; i < report.count; i++) {
      const joint = report.joint[this.order[i] ?? 0] ?? 0;
      if (this.label[joint] === UNLABELLED) this.label[joint] = next++;
    }
  }

  private compareTies(report: MateReport, shapes: SnapShapes, a: number, b: number): number {
    return (
      this.comparePartners(report, a, b) ||
      (report.partnerInstance[a] ?? 0) - (report.partnerInstance[b] ?? 0) ||
      comparePartnerShapes(
        shapes,
        report.partnerShape[a] ?? NO_SHAPE,
        report.partnerShape[b] ?? NO_SHAPE,
      ) ||
      (report.partnerGender[a] ?? 0) - (report.partnerGender[b] ?? 0)
    );
  }

  private comparePartners(report: MateReport, a: number, b: number): number {
    const noneA = (report.partner[a] ?? NO_PARTNER) === NO_PARTNER;
    const noneB = (report.partner[b] ?? NO_PARTNER) === NO_PARTNER;
    if (noneA || noneB) return Number(noneB) - Number(noneA);
    const viewA = this.views[a] ?? null;
    const viewB = this.views[b] ?? null;
    if (!viewA || !viewB) return Number(viewA !== null) - Number(viewB !== null);
    const at = viewA.pose;
    const other = viewB.pose;
    return (
      at.yPlates - other.yPlates ||
      at.x - other.x ||
      at.z - other.z ||
      at.rot - other.rot ||
      (viewA.item < viewB.item ? -1 : viewA.item > viewB.item ? 1 : 0)
    );
  }
}

function comparePartnerShapes(shapes: SnapShapes, a: number, b: number): number {
  if (a === NO_SHAPE || b === NO_SHAPE) return Number(b === NO_SHAPE) - Number(a === NO_SHAPE);
  return shapes.compare(a, b);
}

const canonicalRows = new CanonicalRows();

export function mateCounts(
  report: MateReport,
  shapes: SnapShapes,
  studShapes: Pick<ReadonlySet<number>, "has">,
  placedView: PlacedView,
): ReadonlyArray<HoverMateCount> {
  const rows = canonicalRows;
  rows.sort(report, shapes, placedView);
  const tallies = new Map<number, MateTally>();
  for (let i = 0; i < report.count; i++) {
    const k = rows.order[i] ?? 0;
    const shape = report.shape[k] ?? NO_SHAPE;
    if (shape === NO_SHAPE) continue;
    const gender = report.gender[k] ?? 0;
    const key = shape * 2 + gender;
    let tally = tallies.get(key);
    if (!tally) {
      tally = {
        kind: connectorKind(shapes, shape, gender, studShapes),
        partnerKinds: new Map(),
        connectors: 0,
        joints: new Set(),
        partners: new Map(),
        inferred: 0,
        unverified: 0,
      };
      tallies.set(key, tally);
    }
    tally.connectors++;
    tally.joints.add(rows.label[report.joint[k] ?? 0] ?? 0);
    const partnerShape = report.partnerShape[k] ?? NO_SHAPE;
    const partnerGender = report.partnerGender[k] ?? 0;
    const partnerKey = partnerShape * 2 + partnerGender;
    if (partnerShape !== NO_SHAPE && !tally.partnerKinds.has(partnerKey)) {
      tally.partnerKinds.set(
        partnerKey,
        connectorKind(shapes, partnerShape, partnerGender, studShapes),
      );
    }
    const partner = rows.views[k] ?? null;
    if (partner) tally.partners.set(report.partner[k] ?? NO_PARTNER, partner);
    if (((report.sourceMask[k] ?? 0) & SOURCE_INFERRED) !== 0) tally.inferred++;
    if (report.status[k] === STATUS_UNVERIFIED) tally.unverified++;
  }
  rows.views.fill(null, 0, report.count);
  return hoverCounts(tallies);
}

function hoverCounts(tallies: ReadonlyMap<number, MateTally>): ReadonlyArray<HoverMateCount> {
  return [...tallies.values()].map((tally) => ({
    kind: tally.kind,
    partnerKinds: [...tally.partnerKinds.values()],
    connectors: tally.connectors,
    joints: tally.joints.size,
    jointIds: tally.joints,
    partners: [...tally.partners.values()],
    inferred: tally.inferred,
    unverified: tally.unverified,
  }));
}

export function refusalText(heldLabel: string, hit: HoverRefusalHit | null): string {
  if (!hit) {
    return `${heldLabel} has nothing to rest on here: none of its connectors mate, and it isn't on the table`;
  }
  const part = hit.partLabel || hit.part;
  const model = hit.placed.label || hit.placed.item;
  return `${heldLabel} would overlap ${part}'s bounds in ${model} at cell ${hit.cellX}, ${hit.cellZ}`;
}

export function failedLoadText(subject: string, neighbour: string, place: string): string {
  return `${subject} can't be placed ${place}: ${neighbour}'s connector data didn't load.`;
}
