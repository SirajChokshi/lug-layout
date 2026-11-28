import { STUD_LDU, zeta16ToStuds } from "@brr/math";
import { expect, it } from "vitest";
import { fixtureBundleLoader } from "./fixture-model.test-support.ts";
import { planPartLines } from "./plan-part-lines.ts";

const THOUSANDTHS = 1000;

function endKey(x: number, z: number): string {
  return `${Math.round(x * THOUSANDTHS)},${Math.round(z * THOUSANDTHS)}`;
}

it("starts and ends every track piece's centrelines on its own connectors, in its part's frame", async () => {
  const loader = fixtureBundleLoader();
  const index = await loader.loadIndex("standard");
  const pieces = index.trackCatalog.pieces;
  const checked = [];
  for (const part of index.catalogParts.filter((entry) => entry.role === "track")) {
    const shape = await loader.loadPartShape("standard", part);
    const lines = planPartLines(shape, pieces);
    if (!lines) continue;
    const ends = new Set<string>();
    for (let s = 0; s < lines.centre.length; s += 2) {
      ends.add(endKey(lines.centre[s] ?? 0, lines.centre[s + 1] ?? 0));
    }
    for (const piece of pieces.filter((entry) => entry.part === part.id)) {
      const { xLdu, zLdu, headingHalfSteps } = piece.partFrame;
      const angle = (headingHalfSteps * Math.PI) / 16;
      const missing = piece.connectors.flatMap(({ pose }) => {
        const at = zeta16ToStuds(pose.position);
        const dx = at.x * STUD_LDU - xLdu;
        const dz = at.z * STUD_LDU - zLdu;
        const x = Math.cos(angle) * dx + Math.sin(angle) * dz;
        const z = -Math.sin(angle) * dx + Math.cos(angle) * dz;
        const key = endKey(x, z);
        return ends.has(key) ? [] : [key];
      });
      checked.push({ piece: piece.id, missing });
    }
  }

  expect(checked.length).toBeGreaterThan(0);
  expect(checked.filter((entry) => entry.missing.length > 0)).toEqual([]);
});
