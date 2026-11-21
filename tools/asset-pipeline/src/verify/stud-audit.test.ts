import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LdrawLibrary } from "../ldraw/library.ts";
import { auditPart, measurePart, studPrimitiveFiles, type CompiledPart } from "./stud-audit.ts";

const CUSTOM_PART = [
  "0 Custom Round Plate",
  "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
  "0 BFC CERTIFY CCW",
  "4 16 -10 0 -10 10 0 -10 10 0 10 -10 0 10",
  "1 16 20 -8 0 0 -1 0 1 0 0 0 0 1 stud2a.dat",
  "1 16 0 -24 -20 1 0 0 0 1 0 0 0 1 stud15.dat",
].join("\n");

const SIDE_STUD2A = [0, 1, 0, 20, -1, 0, 0, 8, 0, 0, 1, 0];
const RAISED_STUD15 = [1, 0, 0, 0, 0, 1, 0, 24, 0, 0, 1, 20];
const BODY: CompiledPart["bounds"] = { min: [-10, 0, -10], max: [10, 0, 10] };

function customLibrary(): LdrawLibrary {
  const root = mkdtempSync(join(tmpdir(), "stud-audit-"));
  mkdirSync(join(root, "parts"));
  writeFileSync(join(root, "parts", "custom-round-plate.dat"), CUSTOM_PART);
  return new LdrawLibrary([
    root,
    fileURLToPath(new URL("../../../../.cache/ldraw", import.meta.url)),
  ]);
}

function measured() {
  const library = customLibrary();
  const studFiles = studPrimitiveFiles(library, ["stud.dat", "stud2a.dat", "stud15.dat"]);
  return measurePart(library, "parts/custom-round-plate.dat", studFiles);
}

describe("the stud audit", () => {
  it("finds a custom part's stud references at their y-up poses and passes a GLB that carries them", () => {
    const part = measured();
    expect(part.studs).toEqual([
      { primitive: "stud2a.dat", matrix: SIDE_STUD2A },
      { primitive: "stud15.dat", matrix: RAISED_STUD15 },
    ]);
    expect(part.body).toEqual(BODY);
    const compiled: CompiledPart = {
      id: "custom-round-plate",
      studs: [
        { primitive: "stud15.dat", matrix: RAISED_STUD15 },
        { primitive: "stud2a.dat", matrix: SIDE_STUD2A },
      ],
      bounds: BODY,
    };
    expect(auditPart(part, compiled).issues).toEqual([]);
  });

  it("reports a stud left in the mesh, a moved stud and the bounds the baked stud adds", () => {
    const compiled: CompiledPart = {
      id: "custom-round-plate",
      studs: [{ primitive: "stud2a.dat", matrix: SIDE_STUD2A.with(3, 30) }],
      bounds: { min: BODY.min, max: [10, 28, 20] },
    };
    const audit = auditPart(measured(), compiled);
    expect(audit.issues.map((issue) => issue.kind).toSorted()).toEqual([
      "body-bounds",
      "unextracted-stud",
      "unextracted-stud",
      "unmatched-stud",
    ]);
    expect(Object.fromEntries(audit.baked)).toEqual({ "stud2a.dat": 1, "stud15.dat": 1 });
  });
});
