import {
  GENDER_MALE,
  MateReport,
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
  studShapes: ReadonlySet<number>,
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
const NO_REPORT = new MateReport(1);

class CanonicalRows {
  order = new Int32Array(INITIAL_ROWS);
  label = new Int32Array(INITIAL_ROWS);
  readonly views: Array<PlacedModelView | null> = [];
  private merged = new Int32Array(INITIAL_ROWS);
  private report: MateReport = NO_REPORT;
  private shapes: SnapShapes | null = null;

  sort(report: MateReport, shapes: SnapShapes, placedView: PlacedView): void {
    const n = report.count;
    if (this.order.length < n) {
      this.order = new Int32Array(Math.max(n, this.order.length * 2));
      this.merged = new Int32Array(this.order.length);
    }
    for (let k = 0; k < n; k++) {
      this.order[k] = k;
      const owner = report.partner[k] ?? NO_PARTNER;
      const shaped = (report.shape[k] ?? NO_SHAPE) !== NO_SHAPE;
      this.views[k] = shaped && owner !== NO_PARTNER ? placedView(owner) : null;
    }
    this.report = report;
    this.shapes = shapes;
    this.mergeSort(n);
    this.relabel(report);
    this.report = NO_REPORT;
    this.shapes = null;
  }

  private mergeSort(n: number): void {
    for (let width = 1; width < n; width *= 2) {
      const from = this.order;
      const into = this.merged;
      for (let lo = 0; lo < n; lo += 2 * width) {
        const mid = Math.min(lo + width, n);
        const hi = Math.min(lo + 2 * width, n);
        let left = lo;
        let right = mid;
        let at = lo;
        while (left < mid && right < hi) {
          const l = from[left] ?? 0;
          const r = from[right] ?? 0;
          if (this.compare(r, l) < 0) {
            into[at++] = r;
            right++;
          } else {
            into[at++] = l;
            left++;
          }
        }
        while (left < mid) into[at++] = from[left++] ?? 0;
        while (right < hi) into[at++] = from[right++] ?? 0;
      }
      this.order = into;
      this.merged = from;
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

  private compare(a: number, b: number): number {
    const report = this.report;
    return (
      (report.family[a] ?? 0) - (report.family[b] ?? 0) ||
      (report.connector[a] ?? 0) - (report.connector[b] ?? 0) ||
      this.comparePartners(a, b) ||
      (report.partnerInstance[a] ?? 0) - (report.partnerInstance[b] ?? 0) ||
      this.comparePartnerShapes(
        report.partnerShape[a] ?? NO_SHAPE,
        report.partnerShape[b] ?? NO_SHAPE,
      ) ||
      (report.partnerGender[a] ?? 0) - (report.partnerGender[b] ?? 0)
    );
  }

  private comparePartners(a: number, b: number): number {
    const noneA = (this.report.partner[a] ?? NO_PARTNER) === NO_PARTNER;
    const noneB = (this.report.partner[b] ?? NO_PARTNER) === NO_PARTNER;
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

  private comparePartnerShapes(a: number, b: number): number {
    if (a === NO_SHAPE || b === NO_SHAPE) return Number(b === NO_SHAPE) - Number(a === NO_SHAPE);
    return this.shapes?.compare(a, b) ?? 0;
  }
}

const canonicalRows = new CanonicalRows();

export function mateCounts(
  report: MateReport,
  shapes: SnapShapes,
  studShapes: ReadonlySet<number>,
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
