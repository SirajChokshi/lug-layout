import type { ModelSet } from "@brr/schema/bundle";
import { parseCsv } from "./csv.ts";
import { verifiedText, type RebrickableExportFile } from "./produced-colors.ts";

export const SET_EXPORT = {
  sets: {
    file: "sets.csv.gz",
    sha256: "2c7415bb349066fe34f78c84cff3f24f113c18723f02f1da9ca22d622b9e2739",
  },
  themes: {
    file: "themes.csv.gz",
    sha256: "c8fa2edf3f2b884f6500d1d6d96a5ca6a314fb446ff7793847d34a0f25800c7c",
  },
} as const satisfies Record<string, RebrickableExportFile>;

const RETRIEVED = "2026-11-16";

export const SET_SOURCE = `Rebrickable database export ${SET_EXPORT.sets.file} (sha256 ${SET_EXPORT.sets.sha256}) and ${SET_EXPORT.themes.file} (sha256 ${SET_EXPORT.themes.sha256}), retrieved ${RETRIEVED}`;

const OMR_SET_NUMBER = /^\d+-\d+/u;

export function omrSetNumber(modelName: string): string {
  const number = OMR_SET_NUMBER.exec(modelName)?.[0];
  if (number === undefined) {
    throw new Error(`${modelName} is an OMR model whose file name starts with no set number`);
  }
  return number;
}

export interface SetExport {
  readonly setsCsv: string;
  readonly themesCsv: string;
}

interface Theme {
  readonly name: string;
  readonly parent: string;
}

export function csvRecords(text: string): ReadonlyArray<Readonly<Record<string, string>>> {
  const [header = [], ...rows] = parseCsv(text);
  return rows.map((row) => Object.fromEntries(header.map((name, i) => [name, row[i] ?? ""])));
}

export function themeTable(themesCsv: string): ReadonlyMap<string, Theme> {
  return new Map(
    csvRecords(themesCsv).map((row): [string, Theme] => [
      row["id"] ?? "",
      { name: row["name"] ?? "", parent: row["parent_id"] ?? "" },
    ]),
  );
}

export function themePath(themes: ReadonlyMap<string, Theme>, id: string): ReadonlyArray<string> {
  const path: string[] = [];
  for (let at = id; at !== "";) {
    const theme = themes.get(at);
    if (!theme) throw new Error(`Rebrickable theme ${at} isn't in ${SET_EXPORT.themes.file}`);
    if (path.length >= themes.size) throw new Error(`Rebrickable theme ${id} has a parent loop`);
    path.unshift(theme.name);
    at = theme.parent;
  }
  return path;
}

export function rebrickableSets(
  input: SetExport,
  setNumbers: ReadonlyArray<string>,
): ReadonlyMap<string, ModelSet> {
  const themes = themeTable(input.themesCsv);
  const rows = new Map(csvRecords(input.setsCsv).map((row) => [row["set_num"] ?? "", row]));
  return new Map(
    setNumbers.map((number): [string, ModelSet] => {
      const row = rows.get(number);
      if (!row) throw new Error(`set ${number} isn't in ${SET_EXPORT.sets.file}`);
      return [
        number,
        {
          name: row["name"] ?? "",
          year: Number(row["year"]),
          theme: [...themePath(themes, row["theme_id"] ?? "")],
          source: SET_SOURCE,
        },
      ];
    }),
  );
}

export async function readSetExport(directory: string): Promise<SetExport> {
  return {
    setsCsv: await verifiedText(directory, SET_EXPORT.sets),
    themesCsv: await verifiedText(directory, SET_EXPORT.themes),
  };
}
