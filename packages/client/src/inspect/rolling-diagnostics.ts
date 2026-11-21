import type { CompiledSource, RollingDiagnosticsRows } from "@brr/import";
import {
  ROLLING_STEPS_PER_LDU,
  rollingDiagnosticsFit,
  type RollingDiagnosticsFile,
  type UnreadBand,
  type UnreadBandDiagnostic,
  type UnreadRaw,
} from "@brr/schema/bundle";

export type RollingDiagnosticsSource = "bundle" | CompiledSource;

export interface DiagnosedPart {
  readonly partId: string;
  readonly title: string;
  readonly source: RollingDiagnosticsSource;
  readonly served: ReadonlyArray<UnreadBand>;
}

export type PartRollingDiagnostics =
  | (DiagnosedPart & {
      readonly status: "rows";
      readonly rows: ReadonlyArray<UnreadBandDiagnostic>;
    })
  | (DiagnosedPart & { readonly status: "missing" | "mismatched" | "notKept" });

export interface RollingDiagnosticsView {
  readonly item: string;
  readonly parts: ReadonlyArray<PartRollingDiagnostics>;
}

export function diagnosedPart(
  part: DiagnosedPart,
  bundle: RollingDiagnosticsFile | null,
  bake: RollingDiagnosticsRows,
): PartRollingDiagnostics {
  if (part.source === "import") return { ...part, status: "notKept" };
  const rows = part.source === "bundle" ? bundle?.parts[part.partId] : bake[part.partId];
  if (rows === undefined) return { ...part, status: "missing" };
  if (!rollingDiagnosticsFit(part.served, rows)) return { ...part, status: "mismatched" };
  return { ...part, status: "rows", rows };
}

export function rollingDiagnosticsMessage(part: PartRollingDiagnostics): string {
  const bands = `${part.served.length} unread band${part.served.length === 1 ? "" : "s"}`;
  switch (part.status) {
    case "rows":
      return `${part.partId} (${part.title}): ${bands}`;
    case "notKept":
      return `${part.partId} (${part.title}): its ${bands} were computed at import and their rows aren't kept`;
    case "missing":
      return `${part.partId} (${part.title}): its ${bands} have no rows in the ${part.source === "bundle" ? "bundle's" : "library bake's"} rolling diagnostics`;
    case "mismatched":
      return `${part.partId} (${part.title}): its rolling diagnostics rows don't match its ${bands}`;
    default: {
      const unhandled: never = part;
      throw new Error(`unhandled rolling diagnostics ${JSON.stringify(unhandled)}`);
    }
  }
}

export interface RollingDiagnosticsRowView {
  readonly reason: string;
  readonly identified: string;
  readonly raw: string;
  readonly exact: string;
}

export interface RollingDiagnosticsPartView {
  readonly partId: string;
  readonly message: string;
  readonly rows: ReadonlyArray<RollingDiagnosticsRowView>;
}

export interface RollingDiagnosticsPanel {
  readonly item: string;
  readonly parts: ReadonlyArray<RollingDiagnosticsPartView>;
}

const AXIS_NAMES = ["x", "y", "z"] as const;
const NONE = "none";

type RawValue = UnreadRaw["from"];

function lduText(sixteenths: number | null | undefined): string {
  return sixteenths === null || sixteenths === undefined
    ? NONE
    : String(sixteenths / ROLLING_STEPS_PER_LDU);
}

function rawText(value: RawValue | null): string {
  return value === null ? NONE : String(Number(value.numerator) / Number(value.denominator));
}

function exactText(value: RawValue | null): string {
  return value === null ? NONE : `${value.numerator}/${value.denominator}`;
}

function measured(raw: UnreadRaw, text: (value: RawValue | null) => string): string {
  const ends = `${text(raw.from)} to ${text(raw.to)}`;
  return raw.radii === undefined ? ends : `${ends}, radii ${raw.radii.map(text).join(" and ")}`;
}

function identifiedText(row: UnreadBandDiagnostic): string {
  if (row.reason === "unoriented") return "about a line that is not a part axis";
  const parts = [`axis ${AXIS_NAMES[row.axis]}`];
  if ("at" in row && row.at !== undefined) parts.push(`at ${row.at.map(lduText).join(", ")}`);
  if (row.from !== undefined || row.to !== undefined) {
    parts.push(`${lduText(row.from)} to ${lduText(row.to)}`);
  }
  if (row.radii !== undefined) parts.push(`radii ${row.radii.map(lduText).join(" and ")}`);
  return parts.join(", ");
}

export function rollingDiagnosticsPanel(view: RollingDiagnosticsView): RollingDiagnosticsPanel {
  return {
    item: view.item,
    parts: view.parts.map((part) => ({
      partId: part.partId,
      message: rollingDiagnosticsMessage(part),
      rows:
        part.status === "rows"
          ? part.rows.map((row) => ({
              reason: row.reason,
              identified: identifiedText(row),
              raw: measured(row.raw, rawText),
              exact: measured(row.raw, exactText),
            }))
          : [],
    })),
  };
}
