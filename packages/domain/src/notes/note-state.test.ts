import type { NoteRecordV2, PlacementRecordV1, RulerNoteV2 } from "@brr/schema/world";
import { describe, expect, it } from "vitest";
import {
  followPlacements,
  modelEnd,
  rulerEndPoint,
  type NoteEntry,
  type NoteState,
} from "./note-state.ts";

const COTTAGE: PlacementRecordV1 = {
  ref: "import:aa",
  color: 4,
  x: 200,
  z: -100,
  yPlates: 3,
  rot: 0,
};
const SHED: PlacementRecordV1 = { ...COTTAGE, ref: "import:bb", x: 900, z: 400 };
const ZONE: NoteRecordV2 = {
  kind: "zone",
  index: 0,
  layer: 1,
  name: "Yard",
  color: "#00ff00",
  outline: [
    [0, 0],
    [200, 0],
    [200, 200],
  ],
};

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

function ruler(index: number, from: RulerNoteV2["from"], to: RulerNoteV2["to"]): RulerNoteV2 {
  return { kind: "ruler", index, layer: 1, from, to, color: "#ff0000" };
}

function entries(...notes: ReadonlyArray<NoteRecordV2>): NoteEntry[] {
  return notes.map((note, i) => ({ id: `note-${i + 1}`, note }));
}

function points(state: NoteState) {
  return state.map(({ id, note }) =>
    note.kind === "ruler"
      ? { id, index: note.index, from: rulerEndPoint(note.from), on: note.from.on }
      : { id, index: note.index },
  );
}

describe("model ends", () => {
  it("read back the world point they were attached at, for every quarter turn and offset", () => {
    const next = lcg(16);
    const coordinate = (): number => (next() % 4001) - 2000;
    const misses: string[] = [];
    for (let trial = 0; trial < 400; trial++) {
      const placement = {
        ...COTTAGE,
        x: coordinate() * 20,
        z: coordinate() * 20,
        rot: trial % 4,
      };
      const point = { x: coordinate(), z: coordinate() };
      const read = rulerEndPoint(modelEnd(placement, point));
      if (read.x !== point.x || read.z !== point.z) {
        misses.push(`${JSON.stringify(placement)} ${JSON.stringify(point)}`);
      }
    }
    expect(misses).toEqual([]);
  });
});

describe("followPlacements", () => {
  const attached = modelEnd(COTTAGE, { x: 240, z: -80 });

  it("carries an attached end with its model's move and turn, keeping its model-local offset", () => {
    const state = entries(ZONE, ruler(1, attached, { on: "point", x: 0, z: 0 }));
    const turned = { ...COTTAGE, x: 600, z: 600, rot: 1 };

    const followed = followPlacements(state, [{ before: COTTAGE, after: turned }]);

    expect(followed[1]?.note).toEqual(
      ruler(1, { ...attached, x: 600, z: 600, rot: 1 }, { on: "point", x: 0, z: 0 }),
    );
    expect(rulerEndPoint(attached)).toEqual({ x: 240, z: -80 });
    expect(points(followed)[1]?.from).toEqual({ x: 600 + 20, z: 600 - 40 });
    expect(followed[0]).toBe(state[0]);
  });

  it("maps every end through one edit's moves at once, so two models trading places trade ends", () => {
    const onShed = modelEnd(SHED, { x: 910, z: 410 });
    const state = entries(ruler(0, attached, onShed));

    const followed = followPlacements(state, [
      { before: COTTAGE, after: { ...COTTAGE, x: SHED.x, z: SHED.z } },
      { before: SHED, after: { ...SHED, x: COTTAGE.x, z: COTTAGE.z } },
    ]);

    const note = followed[0]?.note;
    expect(note?.kind === "ruler" && [rulerEndPoint(note.from), rulerEndPoint(note.to)]).toEqual([
      { x: 940, z: 420 },
      { x: 210, z: -90 },
    ]);
  });

  it("frees an end whose model is removed at the point it last marked", () => {
    const state = entries(ruler(0, attached, { on: "point", x: 0, z: 0 }));

    const followed = followPlacements(state, [{ before: COTTAGE, after: null }]);

    expect(followed[0]?.note).toEqual(
      ruler(0, { on: "point", x: 240, z: -80 }, { on: "point", x: 0, z: 0 }),
    );
  });

  it("drops a ruler whose freed end lands on its other end, and keeps the indices dense", () => {
    const state = entries(
      ruler(0, attached, { on: "point", x: 240, z: -80 }),
      { ...ZONE, index: 1 },
      ruler(2, attached, { on: "point", x: 0, z: 0 }),
    );

    const followed = followPlacements(state, [{ before: COTTAGE, after: null }]);

    expect(points(followed)).toEqual([
      { id: "note-2", index: 0 },
      { id: "note-3", index: 1, from: { x: 240, z: -80 }, on: "point" },
    ]);
  });

  it("hands back the same state when no move names an attached model", () => {
    const state = entries(ZONE, ruler(1, attached, { on: "point", x: 0, z: 0 }));

    expect(followPlacements(state, [{ before: SHED, after: null }])).toBe(state);
    expect(followPlacements(state, [{ before: COTTAGE, after: COTTAGE }])).toBe(state);
  });
});
