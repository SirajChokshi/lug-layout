import { TrackPaths, type TrackGraph } from "@brr/domain";
import { inject, injectable } from "inversify";
import { TRACK_WORLD } from "../tokens.ts";
import type { PlacedModel } from "./placed-chunks.ts";
import type { SelectionMember } from "./selection.ts";
import type { ITrackWorld } from "./track-world.ts";

export type TrackPathScope = "run" | "network";

export interface ITrackPathSelection {
  members(piece: number, scope: TrackPathScope): ReadonlyArray<SelectionMember>;
}

function walk(paths: TrackPaths, piece: number, scope: TrackPathScope): Int32Array {
  switch (scope) {
    case "run":
      return paths.run(piece);
    case "network":
      return paths.network(piece);
    default: {
      const unhandled: never = scope;
      throw new Error(`unhandled track path scope ${String(unhandled)}`);
    }
  }
}

@injectable()
export class TrackPathSelection implements ITrackPathSelection {
  private paths: TrackPaths | null = null;

  constructor(
    @inject(TRACK_WORLD) private readonly trackWorld: Pick<ITrackWorld, "drawing" | "carrierOf">,
  ) {}

  members(piece: number, scope: TrackPathScope): ReadonlyArray<SelectionMember> {
    const drawing = this.trackWorld.drawing();
    if (!drawing) return [];
    const laid = drawing.pieceCount;
    const reached = walk(this.pathsOf(drawing.trackGraph), piece, scope);
    const carriers = new Set<PlacedModel>();
    const members: SelectionMember[] = [];
    for (let i = 0; i < reached.length; i++) {
      const placement = reached[i] ?? piece;
      if (placement === piece) continue;
      if (placement < laid) {
        members.push({ kind: "track", placement });
        continue;
      }
      const carrier = this.trackWorld.carrierOf(placement);
      if (!carrier || carriers.has(carrier)) continue;
      carriers.add(carrier);
      members.push({ kind: "model", model: carrier });
    }
    members.push({ kind: "track", placement: piece });
    return members;
  }

  private pathsOf(graph: TrackGraph): TrackPaths {
    if (this.paths?.graph !== graph) this.paths = new TrackPaths(graph);
    return this.paths;
  }
}
