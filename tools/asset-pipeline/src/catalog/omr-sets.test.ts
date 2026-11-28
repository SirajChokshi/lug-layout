import { OmrSetsFile, type OmrLibraryPin, type PaletteModel } from "@brr/schema/bundle";
import { decode } from "@brr/schema/decode";
import { expect, it } from "vitest";
import { deriveOmrSets, omrLibraryProblems } from "./omr-sets.ts";

const MIRROR = {
  kind: "github-mirror",
  repo: "anteloc/ldraw-lib",
  commit: "606be1421f6c353d9f23f6c467e0be1812280455",
  root: "models",
} as const;

const THEMES_CSV = ["id,name,parent_id", "233,Train,", "236,9V,233", "501,Gear,"].join("\n");

const SETS_CSV = [
  "set_num,name,year,theme_id,num_parts,img_url",
  "4551-1,Crocodile Locomotive,1991,236,314,",
  '10022-1,"Santa Fe Cars - Set II (Dining, Observation, or Sleeping Car)",2002,236,411,',
  "60197-1,Passenger Train,2018,236,677,",
  "853176-1,Train Key Chain,2010,501,0,",
].join("\n");

const sha = (digit: string): string => digit.repeat(64);

const PIN: OmrLibraryPin = {
  source: MIRROR,
  files: {
    "10022-1_Dining-Car.mpd": { sha256: sha("a"), bytes: 15259 },
    "10022-1_Sleeping-Car.mpd": { sha256: sha("b"), bytes: 18469 },
    "4551-1.mpd": { sha256: sha("c"), bytes: 14314 },
  },
};

const SOURCES = {
  "rebrickable-sets": {
    repo: "domdfcoding/rebrickable-db",
    commit: "ad9943ccaf97ab9043686d6d94a9cfdb944217d4",
    root: "rebrickable_db/data",
    files: { "sets.csv.gz": sha("d"), "themes.csv.gz": sha("e") },
  },
};

function paletteModel(file: string, sha256: string): PaletteModel {
  return {
    name: file.replace(/\.mpd$/u, ""),
    origin: "omr",
    file,
    sha256,
    source: `https://raw.githubusercontent.com/${MIRROR.repo}/${MIRROR.commit}/models/${file}`,
    retrieved: "2026-11-28",
  };
}

it("lists every set with parts, each pinned model under its set, and themes root first", () => {
  const { file, report } = deriveOmrSets(
    { pin: PIN, setsCsv: SETS_CSV, themesCsv: THEMES_CSV },
    SOURCES,
  );

  expect(decode(OmrSetsFile, file).ok).toBe(true);
  expect(report).toEqual({ sets: 3, modelledSets: 2, models: 3 });
  const setOf = (model: number): string => file.sets.number[file.models.set[model] ?? -1] ?? "";
  expect({
    sets: file.sets.number,
    themes: file.sets.theme.map((theme) => file.themes[theme]),
    models: file.models.file.map((model, index) => [model, setOf(index)]),
  }).toEqual({
    sets: ["4551-1", "10022-1", "60197-1"],
    themes: [
      ["Train", "9V"],
      ["Train", "9V"],
      ["Train", "9V"],
    ],
    models: [
      ["10022-1_Dining-Car.mpd", "10022-1"],
      ["10022-1_Sleeping-Car.mpd", "10022-1"],
      ["4551-1.mpd", "4551-1"],
    ],
  });
});

it("refuses a pinned model whose set the Rebrickable export doesn't list", () => {
  const pin = { ...PIN, files: { ...PIN.files, "4553-1.mpd": { sha256: sha("f"), bytes: 1 } } };

  expect(() => deriveOmrSets({ pin, setsCsv: SETS_CSV, themesCsv: THEMES_CSV }, SOURCES)).toThrow(
    "4553-1.mpd names set 4553-1, which sets.csv.gz lacks",
  );
});

it("reports a palette OMR model the library pins differently, or doesn't pin, and another mirror", () => {
  const models = [
    paletteModel("4551-1.mpd", sha("c")),
    paletteModel("10022-1_Dining-Car.mpd", sha("9")),
    paletteModel("2150-1.mpd", sha("8")),
  ];

  expect(omrLibraryProblems(PIN, MIRROR, models)).toEqual([
    `omr-library.json pins 10022-1_Dining-Car.mpd at ${sha("a")}, not ${sha("9")}`,
    "omr-library.json doesn't list 2150-1.mpd",
  ]);
  expect(omrLibraryProblems(PIN, { ...MIRROR, commit: "0".repeat(40) }, [])).toEqual([
    `omr-library.json pins anteloc/ldraw-lib@${MIRROR.commit}/models, not the palette's OMR source anteloc/ldraw-lib@${"0".repeat(40)}/models`,
  ]);
});
