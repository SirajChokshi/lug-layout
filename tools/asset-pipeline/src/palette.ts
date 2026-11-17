import { OmrErrata, Palette } from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { readFile } from "node:fs/promises";

export async function readPalette(path: string): Promise<Palette> {
  return decodedOrThrow(decode(Palette, JSON.parse(await readFile(path, "utf8"))), path);
}

export async function readOmrErrata(path: string): Promise<OmrErrata> {
  return decodedOrThrow(decode(OmrErrata, JSON.parse(await readFile(path, "utf8"))), path);
}
