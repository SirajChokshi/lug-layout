import { isCanonicalExactDecimalText } from "@brr/math";
import * as v from "valibot";

export const BLUEBRICK_NEWEST_FORMAT = 9;
const OPAQUE_PERCENT = 100;
const UINT32_MAX = 0xffff_ffff;
const RGB_MAX = 0xff_ffff;
const UINT64_MAX = 2n ** 64n - 1n;

const Integer = v.pipe(v.number(), v.integer());
const Index = v.pipe(Integer, v.minValue(0));
const Finite = v.pipe(v.number(), v.finite());

function list<const TItem extends v.GenericSchema>(item: TItem) {
  return v.pipe(v.array(item), v.readonly());
}

export const BlueBrickDecimal = v.pipe(
  v.string(),
  v.check(
    (text) => isCanonicalExactDecimalText(text),
    "must be an exact decimal written canonically",
  ),
  v.description(
    "a decimal exactly as the .bbm printed it, written canonically: studs for positions and sizes, degrees for orientations; read with @brr/math parseExactDecimal",
  ),
);
export type BlueBrickDecimal = v.InferOutput<typeof BlueBrickDecimal>;

export const BlueBrickId = v.pipe(
  v.string(),
  v.regex(/^(?:0|[1-9]\d*)$/u, "must be a whole number written canonically"),
  v.check((id) => BigInt(id) <= UINT64_MAX, "must fit in 64 bits"),
  v.description("a BlueBrick item id: an unsigned 64-bit integer, kept as text"),
);
export type BlueBrickId = v.InferOutput<typeof BlueBrickId>;

export const BlueBrickColor = v.variant("kind", [
  v.strictObject({ kind: v.literal("named"), name: v.string() }),
  v.strictObject({
    kind: v.literal("argb"),
    argb: v.pipe(Integer, v.minValue(0), v.maxValue(UINT32_MAX)),
  }),
]);
export type BlueBrickColor = v.InferOutput<typeof BlueBrickColor>;

export const BlueBrickFont = v.strictObject({
  family: v.string(),
  size: Finite,
  bold: v.boolean(),
  italic: v.boolean(),
  underline: v.boolean(),
  strikeout: v.boolean(),
});
export type BlueBrickFont = v.InferOutput<typeof BlueBrickFont>;

export const BlueBrickRect = v.strictObject({
  x: BlueBrickDecimal,
  y: BlueBrickDecimal,
  width: BlueBrickDecimal,
  height: BlueBrickDecimal,
});
export type BlueBrickRect = v.InferOutput<typeof BlueBrickRect>;

export const BlueBrickPoint = v.strictObject({ x: BlueBrickDecimal, y: BlueBrickDecimal });
export type BlueBrickPoint = v.InferOutput<typeof BlueBrickPoint>;

export const BlueBrickConnectionRef = v.strictObject({
  layer: Index,
  brick: Index,
  connection: Index,
});
export type BlueBrickConnectionRef = v.InferOutput<typeof BlueBrickConnectionRef>;

export const BlueBrickBrickRef = v.strictObject({ layer: Index, brick: Index });
export type BlueBrickBrickRef = v.InferOutput<typeof BlueBrickBrickRef>;

export const BlueBrickGroup = v.strictObject({
  id: BlueBrickId,
  part: v.nullable(v.string()),
  parent: v.nullable(Index),
});
export type BlueBrickGroup = v.InferOutput<typeof BlueBrickGroup>;

const LayerEntries = {
  id: v.nullable(BlueBrickId),
  name: v.string(),
  visible: v.boolean(),
  opacity: v.pipe(Integer, v.minValue(0), v.maxValue(OPAQUE_PERCENT)),
  hull: v.nullable(
    v.strictObject({ visible: v.boolean(), color: BlueBrickColor, thickness: Integer }),
  ),
};

const IndexLabels = v.picklist(["letters", "numbers"]);
const Stroke = v.strictObject({ color: BlueBrickColor, thickness: Finite });

export const BlueBrickGridLayer = v.strictObject({
  ...LayerEntries,
  kind: v.literal("grid"),
  lines: Stroke,
  subLines: Stroke,
  cellSize: Integer,
  subdivisions: Integer,
  showLines: v.nullable(v.boolean()),
  showSubLines: v.boolean(),
  cellIndex: v.strictObject({
    shown: v.boolean(),
    font: BlueBrickFont,
    color: BlueBrickColor,
    columns: IndexLabels,
    rows: IndexLabels,
    origin: v.strictObject({ x: Integer, y: Integer }),
  }),
});
export type BlueBrickGridLayer = v.InferOutput<typeof BlueBrickGridLayer>;

export const BlueBrickConnection = v.strictObject({
  id: BlueBrickId,
  link: v.nullable(BlueBrickConnectionRef),
});
export type BlueBrickConnection = v.InferOutput<typeof BlueBrickConnection>;

export const BlueBrickBrick = v.strictObject({
  id: v.nullable(BlueBrickId),
  part: v.string(),
  area: BlueBrickRect,
  orientation: BlueBrickDecimal,
  altitude: BlueBrickDecimal,
  activeConnection: Integer,
  group: v.nullable(Index),
  connections: list(BlueBrickConnection),
});
export type BlueBrickBrick = v.InferOutput<typeof BlueBrickBrick>;

export const BlueBrickBrickLayer = v.strictObject({
  ...LayerEntries,
  kind: v.literal("brick"),
  showElevation: v.boolean(),
  bricks: list(BlueBrickBrick),
  groups: list(BlueBrickGroup),
});
export type BlueBrickBrickLayer = v.InferOutput<typeof BlueBrickBrickLayer>;

export const BlueBrickAreaLayer = v.strictObject({
  ...LayerEntries,
  kind: v.literal("area"),
  cellSize: Integer,
  cells: list(
    v.strictObject({
      x: Integer,
      y: Integer,
      rgb: v.pipe(Integer, v.minValue(0), v.maxValue(RGB_MAX)),
    }),
  ),
});
export type BlueBrickAreaLayer = v.InferOutput<typeof BlueBrickAreaLayer>;

export const BlueBrickTextCell = v.strictObject({
  area: BlueBrickRect,
  group: v.nullable(Index),
  text: v.string(),
  orientation: BlueBrickDecimal,
  color: BlueBrickColor,
  font: BlueBrickFont,
  alignment: v.picklist(["near", "center", "far"]),
});
export type BlueBrickTextCell = v.InferOutput<typeof BlueBrickTextCell>;

export const BlueBrickTextLayer = v.strictObject({
  ...LayerEntries,
  kind: v.literal("text"),
  texts: list(BlueBrickTextCell),
  groups: list(BlueBrickGroup),
});
export type BlueBrickTextLayer = v.InferOutput<typeof BlueBrickTextLayer>;

const RulerEntries = {
  area: BlueBrickRect,
  group: v.nullable(Index),
  color: BlueBrickColor,
  lineThickness: Finite,
  showDistance: v.boolean(),
  showUnit: v.boolean(),
  guideline: v.strictObject({
    color: BlueBrickColor,
    thickness: Finite,
    dashPattern: list(Finite),
  }),
  unit: v.picklist(["stud", "ldu", "straightTrack", "module", "meter", "feet"]),
  measureFont: BlueBrickFont,
  measureColor: BlueBrickColor,
};

export const BlueBrickRuler = v.variant("shape", [
  v.strictObject({
    ...RulerEntries,
    shape: v.literal("linear"),
    from: BlueBrickPoint,
    to: BlueBrickPoint,
    fromAttachment: v.nullable(BlueBrickBrickRef),
    toAttachment: v.nullable(BlueBrickBrickRef),
    offset: BlueBrickDecimal,
    allowOffset: v.boolean(),
  }),
  v.strictObject({
    ...RulerEntries,
    shape: v.literal("circular"),
    center: BlueBrickPoint,
    radius: BlueBrickDecimal,
    attachment: v.nullable(BlueBrickBrickRef),
  }),
]);
export type BlueBrickRuler = v.InferOutput<typeof BlueBrickRuler>;

export const BlueBrickRulerLayer = v.strictObject({
  ...LayerEntries,
  kind: v.literal("ruler"),
  rulers: list(BlueBrickRuler),
  groups: list(BlueBrickGroup),
});
export type BlueBrickRulerLayer = v.InferOutput<typeof BlueBrickRulerLayer>;

export const BlueBrickLayer = v.variant("kind", [
  BlueBrickGridLayer,
  BlueBrickBrickLayer,
  BlueBrickAreaLayer,
  BlueBrickTextLayer,
  BlueBrickRulerLayer,
]);
export type BlueBrickLayer = v.InferOutput<typeof BlueBrickLayer>;

export const BlueBrickReadIssue = v.variant("kind", [
  v.strictObject({ kind: v.literal("skippedLayer"), position: Index, layerType: v.string() }),
  v.strictObject({
    kind: v.literal("duplicateId"),
    id: BlueBrickId,
    holder: v.picklist(["connection", "brick"]),
  }),
  v.strictObject({ kind: v.literal("duplicateGroup"), layer: Index, id: BlueBrickId }),
  v.strictObject({ kind: v.literal("groupCycle"), layer: Index, group: Index }),
  v.strictObject({
    kind: v.literal("danglingLink"),
    from: BlueBrickConnectionRef,
    target: BlueBrickId,
  }),
  v.strictObject({
    kind: v.literal("unreciprocatedLink"),
    from: BlueBrickConnectionRef,
    to: BlueBrickConnectionRef,
  }),
  v.strictObject({
    kind: v.literal("danglingAttachment"),
    layer: Index,
    ruler: Index,
    end: v.picklist(["from", "to", "center"]),
    target: BlueBrickId,
  }),
]);
export type BlueBrickReadIssue = v.InferOutput<typeof BlueBrickReadIssue>;

const BlueBrickMapShape = v.strictObject({
  version: v.pipe(Integer, v.minValue(0), v.maxValue(BLUEBRICK_NEWEST_FORMAT)),
  properties: v.strictObject({
    author: v.string(),
    lug: v.string(),
    event: v.string(),
    date: v.strictObject({ year: Integer, month: Integer, day: Integer }),
    comment: v.string(),
    background: v.nullable(BlueBrickColor),
  }),
  layers: list(BlueBrickLayer),
  issues: list(BlueBrickReadIssue),
});
type BlueBrickMapShape = v.InferOutput<typeof BlueBrickMapShape>;

type Layers = BlueBrickMapShape["layers"];

function brickLayer(layers: Layers, layer: number): BlueBrickBrickLayer | null {
  const found = layers[layer];
  return found?.kind === "brick" ? found : null;
}

function connectionAt(layers: Layers, at: BlueBrickConnectionRef): BlueBrickConnection | null {
  return brickLayer(layers, at.layer)?.bricks[at.brick]?.connections[at.connection] ?? null;
}

function sameConnection(a: BlueBrickConnectionRef, b: BlueBrickConnectionRef): boolean {
  return a.layer === b.layer && a.brick === b.brick && a.connection === b.connection;
}

function linksReciprocate(layers: Layers): boolean {
  return layers.every(
    (layer, index) =>
      layer.kind !== "brick" ||
      layer.bricks.every((brick, brickIndex) =>
        brick.connections.every((connection, connectionIndex) => {
          if (connection.link === null) return true;
          const from = { layer: index, brick: brickIndex, connection: connectionIndex };
          const back = connectionAt(layers, connection.link)?.link ?? null;
          return (
            !sameConnection(connection.link, from) && back !== null && sameConnection(back, from)
          );
        }),
      ),
  );
}

function groupsOf(layer: BlueBrickLayer): ReadonlyArray<BlueBrickGroup> {
  return layer.kind === "brick" || layer.kind === "text" || layer.kind === "ruler"
    ? layer.groups
    : [];
}

function membersOf(layer: BlueBrickLayer): ReadonlyArray<{ readonly group: number | null }> {
  switch (layer.kind) {
    case "brick":
      return layer.bricks;
    case "text":
      return layer.texts;
    case "ruler":
      return layer.rulers;
    case "grid":
    case "area":
      return [];
    default: {
      const unhandled: never = layer;
      throw new Error(`unhandled ${String(unhandled)}`);
    }
  }
}

function groupsAreTrees(layers: Layers): boolean {
  return layers.every((layer) => {
    const groups = groupsOf(layer);
    const inRange = (group: number | null): boolean => group === null || group < groups.length;
    if (!membersOf(layer).every((member) => inRange(member.group))) return false;
    if (!groups.every((group) => inRange(group.parent))) return false;
    return groups.every((_, start) => {
      let current: number | null = start;
      for (let steps = 0; current !== null; steps += 1) {
        if (steps > groups.length) return false;
        current = groups[current]?.parent ?? null;
      }
      return true;
    });
  });
}

function namesBrick(layers: Layers, at: BlueBrickBrickRef | null): boolean {
  return at === null || brickLayer(layers, at.layer)?.bricks[at.brick] !== undefined;
}

function attachmentsNameBricks(layers: Layers): boolean {
  return layers.every(
    (layer) =>
      layer.kind !== "ruler" ||
      layer.rulers.every((ruler) =>
        ruler.shape === "linear"
          ? namesBrick(layers, ruler.fromAttachment) && namesBrick(layers, ruler.toAttachment)
          : namesBrick(layers, ruler.attachment),
      ),
  );
}

function issueNamesWhatTheMapHas(layers: Layers, issue: BlueBrickReadIssue): boolean {
  switch (issue.kind) {
    case "skippedLayer":
    case "duplicateId":
      return true;
    case "duplicateGroup":
      return layers[issue.layer] !== undefined;
    case "groupCycle": {
      const layer = layers[issue.layer];
      return layer !== undefined && groupsOf(layer)[issue.group] !== undefined;
    }
    case "danglingLink":
      return connectionAt(layers, issue.from) !== null;
    case "unreciprocatedLink":
      return connectionAt(layers, issue.from) !== null && connectionAt(layers, issue.to) !== null;
    case "danglingAttachment": {
      const layer = layers[issue.layer];
      const ruler = layer?.kind === "ruler" ? layer.rulers[issue.ruler] : undefined;
      return ruler !== undefined && (ruler.shape === "linear") === (issue.end !== "center");
    }
    default: {
      const unhandled: never = issue;
      throw new Error(`unhandled ${String(unhandled)}`);
    }
  }
}

export const BlueBrickMap = v.pipe(
  BlueBrickMapShape,
  v.check(
    (map) => linksReciprocate(map.layers),
    "every connection link names another connection on a brick layer that links back to it",
  ),
  v.check(
    (map) => groupsAreTrees(map.layers),
    "every group membership and parent names a group of the same layer, and no group is its own ancestor",
  ),
  v.check(
    (map) => attachmentsNameBricks(map.layers),
    "every ruler attachment names a brick on a brick layer",
  ),
  v.check(
    (map) => map.issues.every((issue) => issueNamesWhatTheMapHas(map.layers, issue)),
    "every read issue names layers, bricks, connections, groups and rulers the map has",
  ),
);
export type BlueBrickMap = v.InferOutput<typeof BlueBrickMap>;

export const BlueBrickRejectionKind = v.picklist(["notXml", "notMap", "newerVersion", "malformed"]);
export type BlueBrickRejectionKind = v.InferOutput<typeof BlueBrickRejectionKind>;

export const BlueBrickRead = v.variant("status", [
  v.strictObject({ status: v.literal("read"), map: BlueBrickMap }),
  v.strictObject({
    status: v.literal("rejected"),
    kind: BlueBrickRejectionKind,
    message: v.string(),
  }),
]);
export type BlueBrickRead = v.InferOutput<typeof BlueBrickRead>;
