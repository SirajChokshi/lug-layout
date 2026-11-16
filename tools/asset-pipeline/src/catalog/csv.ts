import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

const QUOTE = 34;
const COMMA = 44;
const LINE_FEED = 10;
const CARRIAGE_RETURN = 13;

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (quoted) {
      if (code !== QUOTE) cell += text[i];
      else if (text.charCodeAt(i + 1) === QUOTE) {
        cell += '"';
        i++;
      } else quoted = false;
    } else if (code === QUOTE) quoted = true;
    else if (code === COMMA) {
      row.push(cell);
      cell = "";
    } else if (code === LINE_FEED) {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (code !== CARRIAGE_RETURN) cell += text[i];
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export type CsvRecord = Readonly<Record<string, string>>;

export async function readGzipCsv(path: string): Promise<CsvRecord[]> {
  const [header, ...rows] = parseCsv(gunzipSync(await readFile(path)).toString("utf8"));
  if (!header) throw new Error(`${path} is empty`);
  return rows.map((row) => Object.fromEntries(header.map((name, i) => [name, row[i] ?? ""])));
}
