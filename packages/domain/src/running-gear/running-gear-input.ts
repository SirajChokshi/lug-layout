import type { ConnectorTable } from "../connect/connector-table.ts";
import type { ModelConnectors } from "../connect/model-connectors.ts";
import type { SnapShapes } from "../connect/snap-shapes.ts";
import type { PartInstances } from "../connect/submodel-frames.ts";
import type { PartRollingTable } from "./part-rolling.ts";
import type { ExposedConnectors, RunningGearInput } from "./running-gear-detector.ts";

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
  connectors: ReadonlyArray<ConnectorTable | null>,
  model: ModelConnectors,
  shapes: SnapShapes,
): RunningGearInput {
  return {
    instances,
    rolling,
    connectors,
    mates: model.mates,
    exposed: exposedConnectors(model, shapes),
  };
}
