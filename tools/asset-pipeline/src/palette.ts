import { FixtureModels, Palette } from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { readFile } from "node:fs/promises";

export async function readPalette(path: string): Promise<Palette> {
  return decodedOrThrow(decode(Palette, JSON.parse(await readFile(path, "utf8"))), path);
}

export async function readFixtureModels(path: string): Promise<FixtureModels> {
  return decodedOrThrow(decode(FixtureModels, JSON.parse(await readFile(path, "utf8"))), path);
}
