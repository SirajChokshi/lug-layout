import { pose16, ZETA16_COEFFICIENT_COUNT, ZETA16_ORDER, zeta16, type Pose16 } from "@brr/math";

export type TrackPieceKind = "straight" | "curve" | "switch" | "crossing";
export type TrackSystem = "lego-9v" | "lego-plastic";
export type TrackJoinClass = "lego-train";
export type TrackPoseStatus = "certified" | "unverified";

export interface TrackConnector {
  readonly pose: Pose16;
  readonly status: TrackPoseStatus;
  readonly residualLdu: number;
}

export type TrackPathSegment =
  | { readonly kind: "straight"; readonly lengthLdu: number }
  | { readonly kind: "arc"; readonly radiusLdu: number; readonly sweepRadians: number };

export interface TrackRoute {
  readonly from: number;
  readonly to: number;
  readonly lengthLdu: number;
  readonly segments: ReadonlyArray<TrackPathSegment>;
}

export interface TrackPartFrame {
  readonly xLdu: number;
  readonly zLdu: number;
  readonly headingHalfSteps: number;
}

export interface TrackPiece {
  readonly id: string;
  readonly part: string;
  readonly title: string;
  readonly kind: TrackPieceKind;
  readonly system: TrackSystem;
  readonly joinClass: TrackJoinClass;
  readonly status: TrackPoseStatus;
  readonly connectors: ReadonlyArray<TrackConnector>;
  readonly routes: ReadonlyArray<TrackRoute>;
  readonly partFrame: TrackPartFrame;
}

export interface TrackCatalog {
  readonly n: typeof ZETA16_ORDER;
  readonly pieces: ReadonlyArray<TrackPiece>;
}

const PIECE_KINDS: ReadonlyArray<TrackPieceKind> = ["straight", "curve", "switch", "crossing"];
const SYSTEMS: ReadonlyArray<TrackSystem> = ["lego-9v", "lego-plastic"];
const STATUSES: ReadonlyArray<TrackPoseStatus> = ["certified", "unverified"];
const INTEGER = /^-?\d+$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function oneOf<T extends string>(value: unknown, options: ReadonlyArray<T>, label: string): T {
  const match = options.find((option) => option === value);
  if (match === undefined) throw new Error(`${label}: ${String(value)} is not one of ${options}`);
  return match;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label}: expected a finite number`);
  }
  return value;
}

function integer(value: unknown, label: string): number {
  const number = finite(value, label);
  if (!Number.isInteger(number)) throw new Error(`${label}: expected an integer`);
  return number;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label}: expected a string`);
  return value;
}

function list(value: unknown, label: string): ReadonlyArray<unknown> {
  if (!Array.isArray(value)) throw new Error(`${label}: expected an array`);
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label}: expected an object`);
  return value;
}

function parseConnector(value: unknown, label: string): TrackConnector {
  const raw = record(value, label);
  const coefficients = list(raw["coefficients"], `${label}.coefficients`).map((c, k) => {
    if (typeof c !== "string" || !INTEGER.test(c)) {
      throw new Error(`${label}.coefficients[${k}]: expected an integer string`);
    }
    return BigInt(c);
  });
  if (coefficients.length !== ZETA16_COEFFICIENT_COUNT) {
    throw new Error(`${label}.coefficients: expected ${ZETA16_COEFFICIENT_COUNT} coefficients`);
  }
  return {
    pose: pose16(zeta16(coefficients), integer(raw["heading"], `${label}.heading`)),
    status: oneOf(raw["status"], STATUSES, `${label}.status`),
    residualLdu: finite(raw["residualLdu"], `${label}.residualLdu`),
  };
}

function parseSegment(value: unknown, label: string): TrackPathSegment {
  const raw = record(value, label);
  const kind = oneOf(raw["kind"], ["straight", "arc"] as const, `${label}.kind`);
  switch (kind) {
    case "straight":
      return { kind, lengthLdu: finite(raw["lengthLdu"], `${label}.lengthLdu`) };
    case "arc":
      return {
        kind,
        radiusLdu: finite(raw["radiusLdu"], `${label}.radiusLdu`),
        sweepRadians: finite(raw["sweepRadians"], `${label}.sweepRadians`),
      };
    default: {
      const unhandled: never = kind;
      throw new Error(`unhandled ${String(unhandled)}`);
    }
  }
}

function parseRoute(value: unknown, label: string, connectorCount: number): TrackRoute {
  const raw = record(value, label);
  const from = integer(raw["from"], `${label}.from`);
  const to = integer(raw["to"], `${label}.to`);
  if (from < 0 || to < 0 || from >= connectorCount || to >= connectorCount || from === to) {
    throw new Error(`${label}: route ${from}→${to} does not name two connectors`);
  }
  return {
    from,
    to,
    lengthLdu: finite(raw["lengthLdu"], `${label}.lengthLdu`),
    segments: list(raw["segments"], `${label}.segments`).map((segment, index) =>
      parseSegment(segment, `${label}.segments[${index}]`),
    ),
  };
}

function parsePiece(value: unknown, label: string): TrackPiece {
  const raw = record(value, label);
  const connectors = list(raw["connectors"], `${label}.connectors`).map((connector, index) =>
    parseConnector(connector, `${label}.connectors[${index}]`),
  );
  const frame = record(raw["partFrame"], `${label}.partFrame`);
  return {
    id: text(raw["id"], `${label}.id`),
    part: text(raw["part"], `${label}.part`),
    title: text(raw["title"], `${label}.title`),
    kind: oneOf(raw["kind"], PIECE_KINDS, `${label}.kind`),
    system: oneOf(raw["system"], SYSTEMS, `${label}.system`),
    joinClass: oneOf(raw["joinClass"], ["lego-train"] as const, `${label}.joinClass`),
    status: oneOf(raw["status"], STATUSES, `${label}.status`),
    connectors,
    routes: list(raw["routes"], `${label}.routes`).map((route, index) =>
      parseRoute(route, `${label}.routes[${index}]`, connectors.length),
    ),
    partFrame: {
      xLdu: finite(frame["xLdu"], `${label}.partFrame.xLdu`),
      zLdu: finite(frame["zLdu"], `${label}.partFrame.zLdu`),
      headingHalfSteps: integer(frame["headingHalfSteps"], `${label}.partFrame.headingHalfSteps`),
    },
  };
}

export function parseTrackCatalog(value: unknown): TrackCatalog {
  const raw = record(value, "trackCatalog");
  if (raw["n"] !== ZETA16_ORDER) throw new Error(`trackCatalog.n: expected ${ZETA16_ORDER}`);
  return {
    n: ZETA16_ORDER,
    pieces: list(raw["pieces"], "trackCatalog.pieces").map((piece, index) =>
      parsePiece(piece, `trackCatalog.pieces[${index}]`),
    ),
  };
}
