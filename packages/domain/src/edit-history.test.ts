import { POSE16_IDENTITY, STUD_LDU, pose16, zeta16 } from "@brr/math";
import { describe, expect, it } from "vitest";
import {
  EditHistory,
  type ConsistRef,
  type PlacementRef,
  type TrackPieceAt,
} from "./edit-history.ts";
import { ConsistLayout } from "./rail/consist-layout.ts";
import { SLOT_LIVE, World } from "./world.ts";

function livePlacements(world: World): string[] {
  const rows: string[] = [];
  for (const view of world.chunks()) {
    for (let slot = 0; slot < view.count; slot++) {
      if (((view.flags[slot] ?? 0) & SLOT_LIVE) === 0) continue;
      rows.push(
        [
          view.refId[slot],
          view.colorId[slot],
          view.x[slot],
          view.z[slot],
          view.yPlates[slot],
          view.rot[slot],
        ].join(","),
      );
    }
  }
  rows.sort();
  return rows;
}

function liveConsists(layout: ConsistLayout): string[] {
  return layout
    .consists()
    .map(({ pose: { refId, anchor } }) =>
      [refId, anchor.track.piece, anchor.route, anchor.reversed, anchor.offsetLdu].join(","),
    )
    .toSorted();
}

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

function straightAt(index: number, x: bigint): TrackPieceAt {
  return { index, piece: 0, pose: pose16(zeta16([x, 0n, 0n, 0n, 0n, 0n, 0n, 0n]), 0), yPlates: 0 };
}

const LATTICE_SPAN = 4096;
const LONG_SESSION_TIMEOUT_MS = 30_000;

describe("EditHistory", () => {
  it(
    "undoes a long session of model and train edits back to an empty world and redoes it state by state",
    () => {
      const world = new World();
      const trains = new ConsistLayout();
      const history = new EditHistory(world, trains);
      const next = lcg(23);
      const placements: PlacementRef[] = [];
      const consists: ConsistRef[] = [];
      const snapshot = () => [...livePlacements(world), ...liveConsists(trains)];
      const states: string[][] = [snapshot()];
      for (let step = 0; step < 400; step++) {
        const choice = next() % 6;
        const target = placements[next() % Math.max(1, placements.length)];
        const train = consists[next() % Math.max(1, consists.length)];
        if (choice === 4) {
          const consist = history.placeConsist({
            refId: next() % 7,
            colorId: 0,
            anchor: {
              track: { kind: "laid", piece: next() % 5, placement: POSE16_IDENTITY, yPlates: 0 },
              route: next() % 2,
              reversed: next() % 2 === 0,
              offsetLdu: next() % 320,
            },
          }).consists[0]?.consist;
          if (consist) consists.push(consist);
        } else if (choice === 5 && train) {
          history.removeConsist(train);
          consists.splice(consists.indexOf(train), 1);
        } else if (choice === 0 || !target) {
          const edit = history.place({
            refId: next() % 11,
            colorId: next() % 16,
            x: ((next() % LATTICE_SPAN) - LATTICE_SPAN / 2) * STUD_LDU,
            z: ((next() % LATTICE_SPAN) - LATTICE_SPAN / 2) * STUD_LDU,
            yPlates: next() % 3,
            rot: next() % 4,
          });
          const placement = edit.changes[0]?.placement;
          if (placement) placements.push(placement);
        } else if (choice === 3) {
          history.remove(target);
          placements.splice(placements.indexOf(target), 1);
        } else {
          history.rotate(target);
        }
        states.push(snapshot());
      }

      expect(trains.size).toBeGreaterThan(0);
      for (let depth = states.length - 2; depth >= 0; depth--) {
        expect(history.undo()?.step).toBe("undo");
        expect(snapshot()).toEqual(states[depth]);
      }
      expect(world.size + trains.size).toBe(0);
      expect(history.undo()).toBeNull();

      for (let depth = 1; depth < states.length; depth++) {
        expect(history.redo()?.step).toBe("redo");
        expect(snapshot()).toEqual(states[depth]);
      }
      expect(history.redo()).toBeNull();
      expect(history.undoDepth).toBe(states.length - 1);
    },
    LONG_SESSION_TIMEOUT_MS,
  );

  it("reports what each step removed and added so a view can follow the placement", () => {
    const world = new World();
    const history = new EditHistory(world);
    const placed = history.place({ refId: 3, colorId: 2, x: 40, z: -60, yPlates: 0, rot: 0 });
    const placement = placed.changes[0]?.placement;
    if (!placement) throw new Error("place reported no change");
    const firstHandle = placement.handle;

    const rotated = history.rotate(placement);
    expect(rotated.changes[0]?.removed).toBe(firstHandle);
    expect(rotated.changes[0]?.from?.rot).toBe(0);
    expect(rotated.changes[0]?.to?.rot).toBe(1);
    expect(placement.handle).toBe(rotated.changes[0]?.added);

    const undone = history.undo();
    expect(undone?.kind).toBe("rotate");
    expect(undone?.changes[0]?.to?.rot).toBe(0);
    expect(placement.handle?.rot).toBe(0);
    expect(history.nextRedo()).toEqual({ kind: "rotate" });
  });

  it("keeps a track change as one step beside placements, handing it back reversed on undo and as made on redo", () => {
    const world = new World();
    const history = new EditHistory(world);
    history.place({ refId: 1, colorId: 0, x: 0, z: 0, yPlates: 0, rot: 0 });
    const run = { lift: [], lay: [straightAt(0, 0n), straightAt(1, 16n)] };
    const thrown = { lift: [straightAt(1, 16n)], lay: [{ ...straightAt(1, 16n), piece: 2 }] };

    expect(history.commit("lay-track", [], run).track).toBe(run);
    expect(history.commit("throw-switch", [], thrown).track).toBe(thrown);
    expect(history.nextUndo()).toEqual({ kind: "throw-switch", switchAt: 1 });
    expect(history.undo()?.track).toEqual({ lift: thrown.lay, lay: thrown.lift });
    expect(history.undo()).toMatchObject({ kind: "lay-track", track: { lift: run.lay, lay: [] } });
    expect(history.nextUndo()?.kind).toBe("place");
    expect(livePlacements(world)).toEqual(["1,0,0,0,0,0"]);
    expect(history.nextRedo()).toEqual({ kind: "lay-track", pieces: 2 });
    expect(history.redo()?.track).toBe(run);
    expect(history.redo()?.track).toBe(thrown);
    expect([history.undoDepth, history.redoDepth]).toEqual([3, 0]);
  });

  it("keeps placements, track and a plan change committed together as one step, all undone and redone together", () => {
    const world = new World();
    const history = new EditHistory(world);
    const empty = { regions: [], activePlanId: null };
    const opened = { regions: [], activePlanId: "plan-1" };
    const change = { before: empty, after: opened };
    const run = { lift: [], lay: [straightAt(0, 0n)] };

    const done = history.commit(
      "open-plan",
      [
        { placement: null, to: { refId: 1, colorId: 2, x: 0, z: 0, yPlates: 0, rot: 0 } },
        { placement: null, to: { refId: 3, colorId: 0, x: 40, z: 60, yPlates: 1, rot: 3 } },
      ],
      run,
      change,
    );
    expect(done.plan).toBe(change);
    expect(history.nextUndo()).toEqual({ kind: "open-plan", placements: 2, pieces: 1 });

    const undone = history.undo();
    expect(undone).toMatchObject({
      track: { lift: run.lay, lay: [] },
      plan: { before: opened, after: empty },
    });
    expect(livePlacements(world)).toEqual([]);
    expect(history.undoDepth).toBe(0);

    expect(history.redo()).toMatchObject({ track: run, plan: change });
    expect(livePlacements(world)).toEqual(["1,2,0,0,0,0", "3,0,40,60,1,3"]);
  });

  it("drops the redo branch when a new edit follows an undo", () => {
    const world = new World();
    const history = new EditHistory(world);
    history.place({ refId: 1, colorId: 0, x: 0, z: 0, yPlates: 0, rot: 0 });
    history.place({ refId: 2, colorId: 0, x: 640, z: 0, yPlates: 0, rot: 0 });
    history.undo();
    history.place({ refId: 3, colorId: 0, x: 0, z: 640, yPlates: 0, rot: 0 });

    expect(history.redoDepth).toBe(0);
    expect(history.redo()).toBeNull();
    expect(livePlacements(world)).toEqual(["1,0,0,0,0,0", "3,0,0,640,0,0"]);
  });

  it("refuses an edit with an invalid pose without touching the world or the history", () => {
    const world = new World();
    const history = new EditHistory(world);
    const placement = history.place({ refId: 1, colorId: 0, x: 0, z: 0, yPlates: 0, rot: 0 })
      .changes[0]?.placement;
    if (!placement) throw new Error("place reported no change");
    const before = livePlacements(world);

    expect(() =>
      history.commit("remove", [
        { placement, to: null },
        { placement: null, to: { refId: 2, colorId: 0, x: 0.5, z: 0, yPlates: 0, rot: 0 } },
      ]),
    ).toThrow(RangeError);
    expect(() =>
      history.commit("rotate", [
        { placement, to: { refId: 1, colorId: 0, x: 0, z: 0, yPlates: 0, rot: 4 } },
      ]),
    ).toThrow(/quarter turn/u);
    const straight = { piece: 0, pose: pose16(zeta16([0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n]), 0) };
    expect(() =>
      history.commit("remove", [{ placement, to: null }], {
        lift: [
          { ...straight, index: 3, yPlates: 0 },
          { ...straight, index: 1, yPlates: 0 },
        ],
        lay: [],
      }),
    ).toThrow(/ascending/u);
    expect(() =>
      history.commit("lay-track", [], {
        lift: [],
        lay: [{ ...straight, index: 0, yPlates: 2 ** 15 }],
      }),
    ).toThrow(/int16/u);
    expect(livePlacements(world)).toEqual(before);
    expect(history.undoDepth).toBe(1);
  });

  it("refuses placements it does not hold in the world", () => {
    const world = new World();
    const history = new EditHistory(world);
    const placement = history.place({ refId: 1, colorId: 0, x: 0, z: 0, yPlates: 0, rot: 0 })
      .changes[0]?.placement;
    const foreign = new EditHistory(new World()).place({
      refId: 1,
      colorId: 0,
      x: 0,
      z: 0,
      yPlates: 0,
      rot: 0,
    }).changes[0]?.placement;
    if (!placement || !foreign) throw new Error("place reported no change");

    expect(() => history.rotate(foreign)).toThrow(/another edit history/u);
    history.undo();
    expect(() => history.remove(placement)).toThrow(/not in the world/u);
    expect(() => history.commit("rotate", [{ placement: { handle: null }, to: null }])).toThrow(
      /another edit history/u,
    );
  });
});
