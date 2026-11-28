import { noteShards, shardName, type TextNoteV2 } from "@brr/schema/world";
import { describe, expect, it } from "vitest";
import { SavedNoteShards } from "./saved-note-shards.ts";

const FAR_LDU = 6_000;

function text(index: number, x: number, words: string): TextNoteV2 {
  return {
    kind: "text",
    index,
    layer: 1,
    text: words,
    x,
    z: 0,
    rot: 0,
    heightStuds: 2,
    color: "#000000",
  };
}

function names(change: { readonly put: ReadonlyArray<{ readonly superChunk: [number, number] }> }) {
  return change.put.map((shard) => shardName(shard.superChunk));
}

describe("SavedNoteShards", () => {
  const near = text(0, 0, "Station");
  const far = text(1, FAR_LDU, "Depot");

  it("puts only the shards whose notes changed and drops the ones left empty", () => {
    const saved = new SavedNoteShards();
    saved.reset(noteShards([near, far]));

    const renamed = saved.change([near, { ...far, text: "Engine shed" }]);
    const removed = saved.change([{ ...far, index: 0 }]);

    expect({ put: names(renamed), drop: renamed.drop }).toEqual({ put: ["1_0"], drop: [] });
    expect({ put: names(removed), drop: removed.drop }).toEqual({ put: ["1_0"], drop: [[0, 0]] });
  });

  it("compares against what it last accepted, so a change that failed to save is offered again", () => {
    const saved = new SavedNoteShards();
    saved.reset([]);

    const first = saved.change([near]);
    const retried = saved.change([near]);
    saved.accept(retried);

    expect(names(first)).toEqual(["0_0"]);
    expect(retried).toEqual(first);
    expect(saved.change([near])).toEqual({ put: [], drop: [] });
  });
});
