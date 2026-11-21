import { FixtureModels, Palette, PrimitiveConnectorTable } from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { readFile } from "node:fs/promises";

const PRIMITIVE_FOLDER = "p/";

export async function readPalette(path: string): Promise<Palette> {
  return decodedOrThrow(decode(Palette, JSON.parse(await readFile(path, "utf8"))), path);
}

export async function readFixtureModels(path: string): Promise<FixtureModels> {
  return decodedOrThrow(decode(FixtureModels, JSON.parse(await readFile(path, "utf8"))), path);
}

export async function readPrimitiveTable(path: string): Promise<PrimitiveConnectorTable> {
  return decodedOrThrow(
    decode(PrimitiveConnectorTable, JSON.parse(await readFile(path, "utf8"))),
    path,
  );
}

export function studPrimitives(table: PrimitiveConnectorTable): ReadonlyArray<string> {
  return table.primitives
    .filter((entry) => entry.stud === true)
    .map(({ file }) => {
      if (!file.startsWith(PRIMITIVE_FOLDER)) {
        throw new Error(`${file}: a stud primitive lives in ${PRIMITIVE_FOLDER}`);
      }
      return file.slice(PRIMITIVE_FOLDER.length);
    });
}
