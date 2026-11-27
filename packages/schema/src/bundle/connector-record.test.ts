import { describe, expect, it } from "vitest";
import { decode } from "../decode/index.ts";
import { ConnectorRecordFile } from "./index.ts";

const SECTION_BOX = 7;
const SECTION_ROUND = 0;
const AXIS_DOWN = 3;
const ROLL_PLUS_X = 0;
const NO_ROLL = -1;

function record(roll?: ReadonlyArray<number>): unknown {
  return {
    part: "4181.dat",
    license: "CC BY-SA 4.0",
    faces: {
      gender: [1, 1],
      source: [1, 1],
      status: [0, 0],
      caps: [0, 1],
      slide: [false, false],
      group: ["winTrain", ""],
      origin: [64, -576, -480, 0, -1920, 0],
      axis: [AXIS_DOWN, AXIS_DOWN],
      sectionStart: [0, 1],
      sectionCount: [1, 1],
      sectionCode: [SECTION_BOX, SECTION_ROUND],
      sectionSize: [0, 6],
      sectionLength: [0, 4],
      piece: [0, 0],
      ...(roll === undefined ? {} : { roll }),
    },
    free: { face: [], origin: [], axis: [] },
    unreadable: [],
  };
}

describe("ConnectorRecordFile's roll column", () => {
  it("is optional, so a record without box faces reads as it always has", () => {
    const decoded = decode(ConnectorRecordFile, record());
    expect(decoded.ok && decoded.value.faces.roll).toBeUndefined();
  });

  it("reads one axis code or no roll per face", () => {
    const decoded = decode(ConnectorRecordFile, record([ROLL_PLUS_X, NO_ROLL]));
    expect(decoded.ok && decoded.value.faces.roll).toEqual([ROLL_PLUS_X, NO_ROLL]);
  });

  it.each([
    ["one entry short", [ROLL_PLUS_X]],
    ["below no roll", [-2, NO_ROLL]],
    ["past the last axis code", [6, NO_ROLL]],
  ])("is refused %s", (_, roll) => {
    expect(decode(ConnectorRecordFile, record(roll)).ok).toBe(false);
  });
});
