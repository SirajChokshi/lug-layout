import { readFile } from "node:fs/promises";
import { writeStoredZip } from "@brr/storage/zip";

const CC_BY_4 = "Licensed under CC BY 4.0 : see CAreadme.txt";
export const NON_CA = "Not redistributable : see NonCAreadme.txt";
const PINNED_LIBRARY = new URL("../../../.cache/ldraw/", import.meta.url);
const GEOMETRY_LINE = /^(?:[1-5] |0 BFC (?!CERTIFY))/u;
const STUD_REFERENCE = / stud\.dat$/u;

async function pinnedGeometry(path: string): Promise<ReadonlyArray<string>> {
  const text = await readFile(new URL(path, PINNED_LIBRARY), "utf8");
  return text.split(/\r?\n/u).filter((line) => GEOMETRY_LINE.test(line));
}

function customPart(
  name: string,
  license: string | null,
  from: string,
  geometry: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return [
    `0 FILE ${name}`,
    `0 Custom part ${name} written for the custom parts test`,
    `0 Name: ${name}`,
    "0 Author: lug-layout e2e (generated at test time) [James Jessiman]",
    "0 !LDRAW_ORG Unofficial_Part",
    ...(license === null ? [] : [`0 !LICENSE ${license}`]),
    `0 !HISTORY 2026-11-20 [lug-layout] Modified from LDraw ${from}: renamed`,
    "0 BFC CERTIFY CCW",
    ...geometry,
    "0 NOFILE",
  ];
}

export async function customBricksMpd(): Promise<string> {
  const [brick, lower, stud] = await Promise.all([
    pinnedGeometry("parts/3001.dat"),
    pinnedGeometry("parts/s/3001s01.dat"),
    pinnedGeometry("p/stud.dat"),
  ]);
  const walls = brick.filter((line) => !line.startsWith("1 "));
  const ownStuds = lower.map((line) => line.replace(STUD_REFERENCE, " own-stud.dat"));
  return [
    "0 FILE custom-bricks.ldr",
    "0 Custom bricks for the custom parts test",
    "0 Name: custom-bricks.ldr",
    "0 Author: lug-layout e2e (generated at test time)",
    "0 !LDRAW_ORG Model",
    `0 !LICENSE ${CC_BY_4}`,
    "1 4 -40 0 0 1 0 0 0 1 0 0 0 1 stud-brick.dat",
    "1 1 40 0 0 1 0 0 0 1 0 0 0 1 own-stud-brick.dat",
    "1 2 0 0 80 1 0 0 0 1 0 0 0 1 unlicensed.dat",
    "0 NOFILE",
    ...customPart("stud-brick.dat", CC_BY_4, "parts/3001.dat", brick),
    ...customPart("own-stud-brick.dat", CC_BY_4, "parts/s/3001s01.dat", [...walls, ...ownStuds]),
    ...customPart("own-stud.dat", CC_BY_4, "p/stud.dat", stud),
    ...customPart("unlicensed.dat", null, "parts/3001.dat", brick),
    "",
  ].join("\n");
}

export async function studioArchive(): Promise<Uint8Array> {
  const brick = await pinnedGeometry("parts/3001.dat");
  const utf8 = new TextEncoder();
  return writeStoredZip([
    { name: "model.ldr", bytes: utf8.encode("1 1 0 0 0 1 0 0 0 1 0 0 0 1 studiobrick.dat\n") },
    {
      name: "CustomParts/studiobrick.dat",
      bytes: utf8.encode(
        customPart("studiobrick.dat", NON_CA, "parts/3001.dat", brick).slice(1, -1).join("\n"),
      ),
    },
  ]);
}
