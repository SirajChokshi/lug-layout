import {
  GENDER_MALE,
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
import { STUD_LDU } from "@brr/math";
import type {
  ConnectorKindView,
  ConnectorSectionView,
  HoverMateCount,
  HoverRefusalHit,
  PlacedModelView,
  SectionProfile,
} from "./placement-hover.ts";

const BOX_FLOATS = 6;
const MIN_Y = 1;
const MAX_X = 3;
const MAX_Y = 4;
const MAX_Z = 5;

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
  return { gender: male ? "male" : "female", slides: shapes.slides(shape), sections };
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

export function mateCounts(
  report: MateReport,
  shapes: SnapShapes,
  placedView: (owner: number) => PlacedModelView | null,
): ReadonlyArray<HoverMateCount> {
  const tallies = new Map<number, MateTally>();
  for (let k = 0; k < report.count; k++) {
    const shape = report.shape[k] ?? NO_SHAPE;
    if (shape === NO_SHAPE) continue;
    const gender = report.gender[k] ?? 0;
    const key = shape * 2 + gender;
    let tally = tallies.get(key);
    if (!tally) {
      tally = {
        kind: connectorKind(shapes, shape, gender),
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
    tally.joints.add(report.joint[k] ?? 0);
    const partnerShape = report.partnerShape[k] ?? NO_SHAPE;
    const partnerGender = report.partnerGender[k] ?? 0;
    const partnerKey = partnerShape * 2 + partnerGender;
    if (partnerShape !== NO_SHAPE && !tally.partnerKinds.has(partnerKey)) {
      tally.partnerKinds.set(partnerKey, connectorKind(shapes, partnerShape, partnerGender));
    }
    const owner = report.partner[k] ?? -1;
    const partner = owner < 0 ? null : placedView(owner);
    if (partner) tally.partners.set(owner, partner);
    if (((report.sourceMask[k] ?? 0) & SOURCE_INFERRED) !== 0) tally.inferred++;
    if (report.status[k] === STATUS_UNVERIFIED) tally.unverified++;
  }
  return [...tallies.values()].map((tally) => ({
    kind: tally.kind,
    partnerKinds: [...tally.partnerKinds.values()],
    connectors: tally.connectors,
    joints: tally.joints.size,
    partners: [...tally.partners.values()],
    inferred: tally.inferred,
    unverified: tally.unverified,
  }));
}

export interface HitPart {
  readonly part: string;
  readonly partLabel: string;
}

export function partAtHit(
  worldBoxes: Float64Array,
  boxFloats: number,
  cellX: number,
  cellZ: number,
  bottomLdu: number,
  topLdu: number,
  partOf: (instance: number) => HitPart | null,
): HitPart | null {
  const x0 = cellX * STUD_LDU;
  const z0 = cellZ * STUD_LDU;
  for (let b = 0; b < boxFloats; b += BOX_FLOATS) {
    if ((worldBoxes[b] ?? 0) >= x0 + STUD_LDU || (worldBoxes[b + MAX_X] ?? 0) <= x0) continue;
    if ((worldBoxes[b + 2] ?? 0) >= z0 + STUD_LDU || (worldBoxes[b + MAX_Z] ?? 0) <= z0) continue;
    if ((worldBoxes[b + MIN_Y] ?? 0) >= topLdu || (worldBoxes[b + MAX_Y] ?? 0) <= bottomLdu)
      continue;
    const part = partOf(b / BOX_FLOATS);
    if (part) return part;
  }
  return null;
}

export function refusalText(heldLabel: string, hit: HoverRefusalHit | null): string {
  if (!hit) {
    return `${heldLabel} has nothing to rest on here: none of its connectors mate, and it isn't on the table`;
  }
  const part = hit.partLabel ? `${hit.partLabel} in ${hit.placed.label}` : hit.placed.label;
  return `${heldLabel} would hit ${part} at cell ${hit.cellX}, ${hit.cellZ}`;
}
