import { BOX_FLOATS } from "./local-box.ts";
import type { PlacedModel } from "./placed-chunks.ts";

export function trackObstacleRects(
  models: ReadonlyArray<PlacedModel>,
  trackRange: readonly [number, number],
): Float64Array {
  const [bottom, top] = trackRange;
  const rects: number[] = [];
  for (const model of models) {
    const kind = model.placeable.kind;
    switch (kind) {
      case "baseplate":
        break;
      case "road-plate":
        rects.push(model.box.minX, model.box.minZ, model.box.maxX, model.box.maxZ);
        break;
      case "mils-module":
      case "model": {
        const boxes = model.worldPartBoxes();
        for (let b = 0; b < boxes.length; b += BOX_FLOATS) {
          if ((boxes[b + 1] ?? 0) >= top || (boxes[b + 4] ?? 0) <= bottom) continue;
          rects.push(boxes[b] ?? 0, boxes[b + 2] ?? 0, boxes[b + 3] ?? 0, boxes[b + 5] ?? 0);
        }
        break;
      }
      default: {
        const unhandled: never = kind;
        throw new Error(`unhandled placeable kind ${String(unhandled)}`);
      }
    }
  }
  return Float64Array.from(rects);
}
