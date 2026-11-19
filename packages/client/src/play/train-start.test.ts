import { ASSET_FETCHER, PART_BUNDLE_LOADER, type IAssetFetcher } from "@brr/catalog";
import { TrackGraph } from "@brr/domain";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { buildTrackPlan, type TrackPlanLayout } from "../scene/track-plan.ts";
import { TRACK_PARTS } from "../scene/track-scene.ts";
import {
  edgeLengths,
  nextEdge,
  placementBehind,
  trainStart,
  type TrackPosition,
} from "./train-start.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);

class BundleDirectoryFetcher implements IAssetFetcher {
  async bytes(path: string): Promise<ArrayBuffer> {
    const buffer = await readFile(new URL(path, bundleRoot));
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }

  async text(path: string): Promise<string> {
    return readFile(new URL(path, bundleRoot), "utf8");
  }
}

const STRAIGHTS = 12;
const STRAIGHT_LDU = 320;
const LINE = `ldraw:74746*${STRAIGHTS}`;

let plan: (text: string) => TrackPlanLayout;

beforeAll(async () => {
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
  const catalog = (await container.get(PART_BUNDLE_LOADER).load("standard", TRACK_PARTS))
    .trackCatalog;
  plan = (text) => buildTrackPlan(text, catalog);
});

function headDistanceFromTail(graph: TrackGraph, lengths: Float64Array, edge: number): number {
  let behind = lengths[edge] ?? 0;
  let at = nextEdge(graph, edge ^ 1, new Uint8Array(graph.switchCount));
  while (at !== -1) {
    behind += lengths[at] ?? 0;
    at = nextEdge(graph, at, new Uint8Array(graph.switchCount));
  }
  return behind;
}

function fromTail(graph: TrackGraph, lengths: Float64Array, at: TrackPosition): number {
  return headDistanceFromTail(graph, lengths, at.edge) - (lengths[at.edge] ?? 0) + at.offsetLdu;
}

describe("Where play mode puts a train", () => {
  it("puts the whole train on an open line, facing the longer way, with the rest of the line ahead", () => {
    const { layout, catalogPieces } = plan(LINE);
    const graph = new TrackGraph(layout);
    const lengths = edgeLengths(graph, layout, catalogPieces);
    const trainLength = 3.5 * STRAIGHT_LDU;
    const start = trainStart(graph, lengths, new Uint8Array(0), trainLength);
    expect(start).not.toBeNull();
    if (!start) return;
    const behind = headDistanceFromTail(graph, lengths, start.edge);
    expect(behind).toBe(4 * STRAIGHT_LDU);
    expect(start.offsetLdu).toBe(STRAIGHT_LDU);
    expect(start.aheadLdu).toBe((STRAIGHTS - 4) * STRAIGHT_LDU);
  });

  it("starts a following consist head to tail behind the lead one, across pieces, and not past the line's end", () => {
    const { layout, catalogPieces } = plan(LINE);
    const graph = new TrackGraph(layout);
    const lengths = edgeLengths(graph, layout, catalogPieces);
    const states = new Uint8Array(0);
    const start = trainStart(graph, lengths, states, 3.5 * STRAIGHT_LDU);
    if (!start) throw new Error("no start on the line");
    const lead = 1.25 * STRAIGHT_LDU;
    const following = placementBehind(graph, lengths, states, start, lead);
    if (!following) throw new Error("no room behind the lead consist");
    expect(fromTail(graph, lengths, following)).toBe(fromTail(graph, lengths, start) - lead);
    expect(placementBehind(graph, lengths, states, start, 5 * STRAIGHT_LDU)).toBe(null);
  });

  it("finds no start for a train longer than the whole line", () => {
    const { layout, catalogPieces } = plan(LINE);
    const graph = new TrackGraph(layout);
    const lengths = edgeLengths(graph, layout, catalogPieces);
    expect(trainStart(graph, lengths, new Uint8Array(0), (STRAIGHTS + 0.5) * STRAIGHT_LDU)).toBe(
      null,
    );
  });
});
