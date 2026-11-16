import { STUD_LDU } from "@brr/math";
import { describe, expect, it } from "vitest";
import { EditHistory, type PlacementRef } from "./edit-history.ts";
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

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

const LATTICE_SPAN = 4096;

describe("EditHistory", () => {
  it("undoes a long session back to an empty world and redoes it state by state", () => {
    const world = new World();
    const history = new EditHistory(world);
    const next = lcg(23);
    const placements: PlacementRef[] = [];
    const states: string[][] = [livePlacements(world)];
    for (let step = 0; step < 400; step++) {
      const choice = next() % 4;
      const target = placements[next() % Math.max(1, placements.length)];
      if (choice === 0 || !target) {
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
      states.push(livePlacements(world));
    }

    for (let depth = states.length - 2; depth >= 0; depth--) {
      expect(history.undo()?.step).toBe("undo");
      expect(livePlacements(world)).toEqual(states[depth]);
    }
    expect(world.size).toBe(0);
    expect(history.undo()).toBeNull();

    for (let depth = 1; depth < states.length; depth++) {
      expect(history.redo()?.step).toBe("redo");
      expect(livePlacements(world)).toEqual(states[depth]);
    }
    expect(history.redo()).toBeNull();
    expect(history.undoDepth).toBe(states.length - 1);
  });

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
    expect(history.nextRedo()).toBe("rotate");
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
