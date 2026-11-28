import type { ProducedColors } from "@brr/schema/bundle";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

export interface RebrickableExportFile {
  readonly file: string;
  readonly sha256: string;
}

export const REBRICKABLE_EXPORT = {
  elements: {
    file: "elements.csv.gz",
    sha256: "ce7d365f3a8359753ca61edb9fb3dd32597669f26e2312247fc2d965ac5ae88e",
  },
  colors: {
    file: "colors.csv.gz",
    sha256: "3eb7dbb76409f8234d321cfc767ffa31fd54f1b01c6ad4f199e5baf4bdf66095",
  },
} as const satisfies Record<string, RebrickableExportFile>;

export interface ExcludedColor {
  readonly part: string;
  readonly rebrickableColor: number;
  readonly reason: string;
}

export interface ProducedColorReport {
  readonly parts: ReadonlyMap<string, ProducedColors>;
  readonly excluded: ReadonlyArray<ExcludedColor>;
}

interface LdrawColor {
  readonly code: number;
  readonly name: string;
}

const REBRICKABLE_KEYWORD = /Rebrickable\s+([^\s,]+)/u;
const LDCONFIG_COLOUR = /^0\s+!COLOUR\s+(\S+)\s+CODE\s+(\d+)\s/u;

export async function verifiedText(
  directory: string,
  entry: RebrickableExportFile,
): Promise<string> {
  const bytes = await readFile(join(directory, entry.file));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== entry.sha256) {
    throw new Error(`${entry.file} is sha256 ${sha256}, but the pin is ${entry.sha256}`);
  }
  return gunzipSync(bytes).toString("utf8");
}

function csvRows(text: string): ReadonlyArray<ReadonlyArray<string>> {
  return text
    .split("\n")
    .slice(1)
    .filter((line) => line.length > 0)
    .map((line) => line.split(","));
}

export function comparableColorName(name: string): string {
  return name
    .toLowerCase()
    .replaceAll("grey", "gray")
    .replace(/[^a-z0-9]/gu, "");
}

export function ldconfigColors(text: string): ReadonlyMap<number, LdrawColor> {
  const colors = new Map<number, LdrawColor>();
  for (const line of text.split("\n")) {
    const match = LDCONFIG_COLOUR.exec(line.trim());
    if (!match?.[1] || !match[2]) continue;
    const code = Number(match[2]);
    colors.set(code, { code, name: match[1] });
  }
  return colors;
}

export function rebrickablePartNumber(ldrawId: string, datText: string): string {
  return REBRICKABLE_KEYWORD.exec(datText)?.[1] ?? ldrawId;
}

export interface ProducedColorInputs {
  readonly elementsCsv: string;
  readonly colorsCsv: string;
  readonly ldconfig: string;
  readonly parts: ReadonlyArray<{ readonly id: string; readonly datText: string }>;
}

export function producedColors(inputs: ProducedColorInputs): ProducedColorReport {
  const rebrickableNames = new Map<number, string>();
  for (const [id, name] of csvRows(inputs.colorsCsv)) {
    if (id !== undefined && name !== undefined) rebrickableNames.set(Number(id), name);
  }
  const ldraw = ldconfigColors(inputs.ldconfig);
  const elementsByPart = new Map<string, Map<number, string[]>>();
  for (const [element, part, color] of csvRows(inputs.elementsCsv)) {
    if (element === undefined || part === undefined || color === undefined) continue;
    const byColor = elementsByPart.get(part) ?? new Map<number, string[]>();
    const code = Number(color);
    byColor.set(code, [...(byColor.get(code) ?? []), element]);
    elementsByPart.set(part, byColor);
  }
  const parts = new Map<string, ProducedColors>();
  const excluded: ExcludedColor[] = [];
  for (const { id, datText } of inputs.parts) {
    const rebrickable = rebrickablePartNumber(id, datText);
    const colors: ProducedColors["colors"] = [];
    const byColor = elementsByPart.get(rebrickable) ?? new Map<number, string[]>();
    for (const [code, elements] of [...byColor].toSorted(([a], [b]) => a - b)) {
      const rebrickableName = rebrickableNames.get(code) ?? "";
      const ldrawColor = ldraw.get(code);
      if (!ldrawColor) {
        excluded.push({
          part: id,
          rebrickableColor: code,
          reason: "no LDConfig colour with this code",
        });
        continue;
      }
      if (comparableColorName(ldrawColor.name) !== comparableColorName(rebrickableName)) {
        excluded.push({
          part: id,
          rebrickableColor: code,
          reason: `Rebrickable "${rebrickableName}" is LDConfig "${ldrawColor.name}" at the same code`,
        });
        continue;
      }
      colors.push({ ldraw: code, elements: elements.toSorted() });
    }
    parts.set(id, { rebrickable, colors });
  }
  return { parts, excluded };
}

export async function readProducedColorInputs(
  rebrickableDirectory: string,
  ldrawRoot: string,
  partIds: ReadonlyArray<string>,
): Promise<ProducedColorInputs> {
  return {
    elementsCsv: await verifiedText(rebrickableDirectory, REBRICKABLE_EXPORT.elements),
    colorsCsv: await verifiedText(rebrickableDirectory, REBRICKABLE_EXPORT.colors),
    ldconfig: await readFile(join(ldrawRoot, "LDConfig.ldr"), "utf8"),
    parts: await Promise.all(
      partIds.map(async (id) => ({
        id,
        datText: await readFile(join(ldrawRoot, "parts", `${id}.dat`), "utf8"),
      })),
    ),
  };
}
