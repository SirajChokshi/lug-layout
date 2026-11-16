import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LdrawLibrary } from "./library.ts";
import { dependencyClosure } from "./closure.ts";
import { walkPart, type PlacedPolygon } from "./walk.ts";

const root = mkdtempSync(join(tmpdir(), "ldraw-walk-"));
mkdirSync(join(root, "parts", "s"), { recursive: true });
mkdirSync(join(root, "p"), { recursive: true });
writeFileSync(
  join(root, "parts", "outer.dat"),
  [
    "0 Outer Test Part",
    "0 Name: outer.dat",
    "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
    "1 4 100 0 0 0 0 1 0 1 0 -1 0 0 S\\INNER.DAT",
    "1 16 0 0 0 1 0 0 0 1 0 0 0 1 absent.dat",
  ].join("\r\n"),
);
writeFileSync(
  join(root, "parts", "s", "inner.dat"),
  ["0 ~Inner", "1 16 0 -8 20 2 0 0 0 1 0 0 0 1 quad.dat"].join("\n"),
);
writeFileSync(join(root, "p", "quad.dat"), ["0 Quad", "4 16 0 0 0 1 0 0 1 0 1 0 0 1"].join("\n"));

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("walkPart", () => {
  const library = new LdrawLibrary([root]);

  it("composes nested type-1 matrices, inherits color 16 and reports missing files", () => {
    const polygons: PlacedPolygon[] = [];
    const result = walkPart(library, "outer.dat", { polygon: (placed) => polygons.push(placed) });

    expect(polygons).toEqual([
      {
        color: 4,
        vertices: [
          [120, -8, 0],
          [120, -8, -2],
          [121, -8, -2],
          [121, -8, 0],
        ],
      },
    ]);
    expect([...result.visitedFiles].toSorted()).toEqual(["outer.dat", "quad.dat", "s/inner.dat"]);
    expect([...result.missingFiles]).toEqual(["absent.dat"]);
  });

  it("finds the same dependency closure without placing geometry", () => {
    const closure = dependencyClosure(library, "OUTER.dat");
    expect(closure.visitedFiles.size).toBe(3);
    expect([...closure.missingFiles]).toEqual(["absent.dat"]);
  });
});
