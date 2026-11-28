import { OMR_SETS_FORMAT, type OmrSetsFile } from "@brr/schema/bundle";
import { describe, expect, it } from "vitest";
import { LibraryQuery } from "./library-query.ts";
import { OmrSetIndex } from "./omr-set-index.ts";

const COMMIT = "606be1421f6c353d9f23f6c467e0be1812280455";
const RAW = `https://raw.githubusercontent.com/anteloc/ldraw-lib/${COMMIT}/models`;
const sha = (digit: string): string => digit.repeat(64);

const FILE: OmrSetsFile = {
  format: OMR_SETS_FORMAT,
  mirror: { kind: "github-mirror", repo: "anteloc/ldraw-lib", commit: COMMIT, root: "models" },
  sources: {},
  themes: [
    ["Train", "9V"],
    ["Train", "12V"],
    ["City", "Trains"],
  ],
  sets: {
    number: ["4551-1", "60197-1", "7740-1", "10022-1", "2150-1"],
    name: [
      "Crocodile Locomotive",
      "Passenger Train",
      "Inter-City Passenger Train",
      "Santa Fe Cars - Set II",
      "Train Station",
    ],
    year: [1991, 2018, 1980, 2002, 1996],
    theme: [0, 2, 1, 0, 0],
    parts: [314, 677, 787, 411, 610],
  },
  models: {
    file: [
      "10022-1_Dining-Car.mpd",
      "10022-1_Sleeping-Car.mpd",
      "2150-1.mpd",
      "4551-1.mpd",
      "7740-1.mpd",
    ],
    sha256: [sha("a"), sha("b"), sha("c"), sha("d"), sha("e")],
    bytes: [15259, 18469, 38887, 14314, 39155],
    set: [3, 3, 4, 0, 2],
  },
};

const PALETTE = new Set(["omr:10022-1_Dining-Car", "omr:2150-1", "ldraw:3811@2"]);

function numbers(index: OmrSetIndex, text: string): ReadonlyArray<string> {
  return index.search(LibraryQuery.parse(text), 10, PALETTE).hits.map((set) => set.number);
}

describe("OmrSetIndex", () => {
  const index = new OmrSetIndex(FILE);

  it("finds a set by number with its pinned model, and leaves out the models the palette offers", () => {
    const [crocodile] = index.search(LibraryQuery.parse("4551"), 10, PALETTE).hits;
    const [santaFe] = index.search(LibraryQuery.parse("santa fe"), 10, PALETTE).hits;

    expect(crocodile?.models).toEqual([
      {
        item: `import:${sha("d")}`,
        file: "4551-1.mpd",
        variant: null,
        sha256: sha("d"),
        bytes: 14314,
        url: `${RAW}/4551-1.mpd`,
      },
    ]);
    expect(santaFe?.models.map((model) => model.variant)).toEqual(["Sleeping Car"]);
    expect(numbers(index, "station")).toEqual([]);
    expect({ size: index.size, modelled: index.modelled }).toEqual({ size: 5, modelled: 4 });
  });

  it("ranks a set with a model before an equally good match without one, which it still lists", () => {
    expect(numbers(index, "passenger train")).toEqual(["7740-1", "60197-1"]);
    expect(numbers(index, "60197")).toEqual(["60197-1"]);
  });

  it("matches theme and year words, and drops sets an excluded word matches", () => {
    expect(numbers(index, "12v")).toEqual(["7740-1"]);
    expect(numbers(index, "train -passenger")).toEqual(["4551-1", "10022-1"]);
  });
});
