import type { ConnectorTable } from "../connect/connector-table.ts";
import type { ModelConnectors } from "../connect/model-connectors.ts";
import type { SnapShapes } from "../connect/snap-shapes.ts";
import type { PartInstances } from "../connect/submodel-frames.ts";
import type { PartExtents } from "./part-extents.ts";
import type { PartRollingTable } from "./part-rolling.ts";
import type { ExposedConnectors, RunningGearInput } from "./running-gear-detector.ts";
import type { WrittenTransforms } from "./written-transforms.ts";

export function exposedConnectors(model: ModelConnectors, shapes: SnapShapes): ExposedConnectors {
  return {
    count: model.count,
    instance: model.instance,
    connector: model.connector,
    axis: model.axis,
    origin: model.origin,
    reach: Float32Array.from(model.shape, (shape) => shapes.length(shape)),
  };
}

export function runningGearInput(
  instances: PartInstances,
  rolling: ReadonlyArray<PartRollingTable | null>,
  extents: ReadonlyArray<PartExtents | null>,
  connectors: ReadonlyArray<ConnectorTable | null>,
  model: ModelConnectors,
  shapes: SnapShapes,
  written: WrittenTransforms | null,
): RunningGearInput {
  return {
    instances,
    rolling,
    extents,
    connectors,
    mates: model.mates,
    exposed: exposedConnectors(model, shapes),
    written,
  };
}
