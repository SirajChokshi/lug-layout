import { describe, expect, it } from "vitest";
import {
  AXIS_NEG_Y,
  AXIS_POS_Y,
  ConnectorTable,
  GENDER_FEMALE,
  GENDER_MALE,
  SOURCE_SHADOW,
  STATUS_VERIFIED,
} from "./connector-table.ts";
import { MateClasses } from "./mate-classes.ts";
import { SnapMating } from "./mating.ts";
import { ModelConnectors } from "./model-connectors.ts";
import { CAP_FAR, CAP_ROOT, SECTION_AXLE, SECTION_ROUND, SnapShapes } from "./snap-shapes.ts";

const SIXTEENTHS_PER_LDU = 16;
const shapes = new SnapShapes();
const mating = new SnapMating(shapes);

function shape(caps: number, code: number, size: number, length: number): number {
  return shapes.intern(caps, false, [code], [size], [length]);
}

const STUD = shape(CAP_ROOT, SECTION_ROUND, 6, 4);
const PLATE_RECEPTOR = shape(CAP_FAR, SECTION_ROUND, 6, 4);
const BRICK_RECEPTOR = shape(CAP_FAR, SECTION_ROUND, 6, 20);
const AXLE = shape(CAP_ROOT, SECTION_AXLE, 6, 40);

interface Connector {
  readonly shape: number;
  readonly gender: number;
}

function modelOf(connectors: ReadonlyArray<Connector>): ModelConnectors {
  const part = new ConnectorTable(
    Uint16Array.from(connectors, (c) => c.shape),
    Uint8Array.from(connectors, (c) => c.gender),
    Uint8Array.from(connectors, () => SOURCE_SHADOW),
    Uint8Array.from(connectors, () => STATUS_VERIFIED),
    Int32Array.from(connectors.flatMap((_, i) => [i * 20 * SIXTEENTHS_PER_LDU, 0, 0])),
    Int8Array.from(connectors, (c) => (c.gender === GENDER_MALE ? AXIS_POS_Y : AXIS_NEG_Y)),
    new Float64Array(connectors.length * 3),
    new Uint16Array(connectors.length),
    new Float64Array(connectors.length * 3),
    [],
  );
  return ModelConnectors.fromParts(
    [part],
    { count: 1, partIndex: [0], matrices: Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0) },
    mating,
  );
}

describe("MateClasses", () => {
  it("numbers a model's classes in the order its connectors first show them, continuing across models", () => {
    const classes = new MateClasses(mating);
    const first = modelOf([
      { shape: PLATE_RECEPTOR, gender: GENDER_FEMALE },
      { shape: STUD, gender: GENDER_MALE },
      { shape: PLATE_RECEPTOR, gender: GENDER_FEMALE },
      { shape: BRICK_RECEPTOR, gender: GENDER_FEMALE },
    ]);
    const second = modelOf([
      { shape: STUD, gender: GENDER_MALE },
      { shape: AXLE, gender: GENDER_MALE },
      { shape: STUD, gender: GENDER_FEMALE },
    ]);

    const firstIds = [...classes.classesOf(first)];
    const secondIds = [...classes.classesOf(second)];

    const seen = (ids: ReadonlyArray<number>, model: ModelConnectors) =>
      ids.map((id, i) => [
        id,
        classes.shapeOf(id),
        classes.genderOf(id),
        model.shape[i],
        model.gender[i],
      ]);
    expect(seen(firstIds, first).every(([, s, g, ms, mg]) => s === ms && g === mg)).toBe(true);
    expect(seen(secondIds, second).every(([, s, g, ms, mg]) => s === ms && g === mg)).toBe(true);
    const firstSeen = [...new Set([...firstIds, ...secondIds])];
    expect(firstSeen).toEqual(firstSeen.map((_, rank) => rank));
    expect(classes.count).toBe(firstSeen.length);
  });
});
