import {
  ASSET_FETCHER,
  INHERIT_COLOR,
  PART_BUNDLE_LOADER,
  type IAssetFetcher,
  type PartAsset,
} from "@brr/catalog";
import type { TrackCatalog } from "@brr/schema/bundle";
import { NO_EDGE, NO_SWITCH, TrackGraph, TrackLayout } from "@brr/domain";
import { POSE16_IDENTITY } from "@brr/math";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { buildTrackPlan } from "./track-plan.ts";

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

const BALLOON =
  "ldraw:74746, ldraw:74747.1*3, ldraw:74747*7, ldraw:74746, ldraw:74747*5, ldraw:74746*5";
const DOGBONE = [
  "ldraw:75541-f1",
  BALLOON,
  "/",
  "ldraw:74746*2, ldraw:75541-f1, ldraw:74746*8, ldraw:75542-f1.1, ldraw:74746*2, ldraw:75541-f1",
  BALLOON,
  "/",
  "ldraw:74747, ldraw:74746*6, ldraw:74747",
].join(", ");

let catalog: TrackCatalog;
let trackParts: ReadonlyArray<PartAsset>;

beforeAll(async () => {
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
  const bundle = await container
    .get(PART_BUNDLE_LOADER)
    .load("standard", (part) => part.role === "track");
  catalog = bundle.trackCatalog;
  trackParts = bundle.parts;
});

describe("track graph from catalog pieces", () => {
  it("closes a circle of R40 curves only after sixteen, and leaves a short loop open", () => {
    const circle = new TrackGraph(buildTrackPlan("ldraw:74747*16", catalog).layout);
    expect([circle.joinCount, circle.openEnds.length, circle.issues.length]).toEqual([16, 0, 0]);

    const short = new TrackGraph(buildTrackPlan("ldraw:74747*15, ldraw:74746", catalog).layout);
    expect(short.joinCount).toBe(15);
    expect(Array.from(short.openEnds, (end) => short.endPlacement[end])).toEqual([0, 15]);
  });

  it("joins a dogbone with two reversing loops so every directed edge reaches every other", () => {
    const graph = new TrackGraph(buildTrackPlan(DOGBONE, catalog).layout);
    expect([graph.openEnds.length, graph.issues.length, graph.switchCount]).toEqual([0, 0, 4]);
    for (let edge = 0; edge < graph.edgeCount; edge++) {
      expect(graph.reachableEdgeCount(edge)).toBe(graph.edgeCount);
    }
  });

  it("lets a facing switch's state choose the route and gives a trailing move one way on", () => {
    const { layout } = buildTrackPlan("ldraw:74746, ldraw:75541-f1, ldraw:74746", catalog);
    const graph = new TrackGraph(layout);
    const states = new Uint8Array(graph.switchCount);
    const facing = 0;
    expect(graph.edgeSwitch[facing]).not.toBe(NO_SWITCH);
    const straight = graph.successor(facing, states);
    states[graph.edgeSwitch[facing] ?? 0] = 1;
    const diverging = graph.successor(facing, states);
    expect([graph.edgePlacement[straight], graph.edgeRoute[straight]]).toEqual([1, 0]);
    expect([graph.edgePlacement[diverging], graph.edgeRoute[diverging]]).toEqual([1, 1]);
    expect(graph.successor(diverging, states)).toBe(NO_EDGE);

    const trailing = graph.reverse(graph.successor(straight, states));
    expect(graph.edgeSwitch[trailing]).toBe(NO_SWITCH);
    expect(graph.successorCount(trailing)).toBe(1);
    expect(graph.successor(trailing, states)).toBe(graph.reverse(straight));
  });

  it("reports coincident ends that do not face each other instead of joining them", () => {
    const { layout: planned } = buildTrackPlan("ldraw:74746", catalog);
    const layout = new TrackLayout(planned.pieces);
    const piece = planned.piece(0);
    layout.place(piece, POSE16_IDENTITY, 0);
    layout.place(piece, POSE16_IDENTITY, 0);
    const graph = new TrackGraph(layout);
    expect([graph.joinCount, graph.openEnds.length, graph.issues.length]).toEqual([0, 4, 2]);
  });

  it("gives every catalog track piece a sourced produced colour, never the inherited placeholder", () => {
    const uncoloured = catalog.pieces
      .filter((piece) => {
        const colour = trackParts.find((asset) => asset.id === piece.part)?.producedColor;
        return colour === undefined || colour === INHERIT_COLOR;
      })
      .map((piece) => piece.part);
    expect(uncoloured).toEqual([]);
  });
});
