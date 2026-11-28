import { expect, it } from "vitest";
import { omrSetNumber, rebrickableSets, SET_SOURCE } from "./rebrickable-sets.ts";

const THEMES_CSV = [
  "id,name,parent_id",
  "50,Town,",
  "105,World City,50",
  "155,Modular Buildings,",
  "233,Train,",
  "236,9V,233",
].join("\n");

const SETS_CSV = [
  "set_num,name,year,theme_id,num_parts,img_url",
  "10185-1,Green Grocer,2008,155,2352,https://cdn.rebrickable.com/media/sets/10185-1.jpg",
  '10022-1,"Santa Fe Cars - Set II (Dining, Observation, or Sleeping Car)",2002,236,1080,',
  "10128-1,Train Level Crossing,2003,105,382,",
].join("\n");

it("names each set and its Rebrickable theme from the export, root theme first", () => {
  const sets = rebrickableSets({ setsCsv: SETS_CSV, themesCsv: THEMES_CSV }, [
    omrSetNumber("10022-1_Dining-Car"),
    omrSetNumber("10185-1"),
    omrSetNumber("10128-1"),
  ]);

  expect(Object.fromEntries(sets)).toEqual({
    "10022-1": {
      name: "Santa Fe Cars - Set II (Dining, Observation, or Sleeping Car)",
      year: 2002,
      theme: ["Train", "9V"],
      source: SET_SOURCE,
    },
    "10185-1": {
      name: "Green Grocer",
      year: 2008,
      theme: ["Modular Buildings"],
      source: SET_SOURCE,
    },
    "10128-1": {
      name: "Train Level Crossing",
      year: 2003,
      theme: ["Town", "World City"],
      source: SET_SOURCE,
    },
  });
});

it("refuses a set the export doesn't list, a theme it doesn't list and an OMR file with no set number", () => {
  const input = { setsCsv: SETS_CSV, themesCsv: THEMES_CSV };
  const orphan = { setsCsv: `${SETS_CSV}\n9999-1,Orphan,2001,999,1,`, themesCsv: THEMES_CSV };

  expect(() => rebrickableSets(input, ["4554-1"])).toThrow("set 4554-1 isn't in sets.csv.gz");
  expect(() => rebrickableSets(orphan, ["9999-1"])).toThrow(
    "Rebrickable theme 999 isn't in themes.csv.gz",
  );
  expect(() => omrSetNumber("Metro Station")).toThrow("starts with no set number");
});
