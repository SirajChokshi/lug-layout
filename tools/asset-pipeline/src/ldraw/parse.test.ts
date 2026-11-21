import { describe, expect, it } from "vitest";
import { parseLdraw, snapIncludeReferences } from "./parse.ts";

describe("snapIncludeReferences", () => {
  it("reads each SNAP_INCL's ref the way brick-compile's meta parser does", () => {
    const shadow = [
      "0 !LDCAD SNAP_INCL [ref=3673.dat]",
      "0 !LDCAD SNAP_INCL [pos=0 24 0] [REF= S\\3001S01.DAT ] [grid=C 2 1 20 0]",
      "0 //!LDCAD SNAP_INCL [ref=commented.dat]",
      "0 // !LDCAD SNAP_INCL [ref=spaced-comment.dat]",
      "0 !LDCADSNAP_INCL [ref=fused.dat]",
      "0 !LDCAD SNAP_CYL [ref=not-an-include.dat] [gender=M] [secs=R 6 4]",
      "0 !LDCAD SNAP_INCL [pos=0 0 0]",
    ].join("\n");
    expect(snapIncludeReferences(parseLdraw(shadow))).toEqual(["3673.dat", "s/3001s01.dat"]);
  });
});
