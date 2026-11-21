import type { TrackCarrier } from "./track-drawing.ts";

export function carrierAtOrigin(held: number): TrackCarrier {
  return {
    model: {
      handle: { chunkKey: 0, slot: 0, x: 0, z: 0 },
      placeable: { label: "Carrier" },
      box: { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 },
    },
    held,
    unverified: [],
    unidentified: [],
  };
}
