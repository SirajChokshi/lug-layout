import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { LdrawLibrary } from "../ldraw/library.ts";
import { buildTrackPiece } from "./track-catalog.ts";
import { CERTIFIED_RESIDUAL_LIMIT_LDU, loadTrackEndMarkers } from "./track-ends.ts";

const PINNED_LIBRARY = fileURLToPath(new URL("../../../../.cache/ldraw/", import.meta.url));
const R40_LDU = 800;
const HALF_TURN_STEP_RADIANS = Math.PI / 16;
const PLASTIC_END_X_AS_PRINTED = 156.073;
const PRINTED_DIGITS = 12;

it("keeps the plastic curve's exit unverified, because its printed ends sit off the R40 chord, while the 9V curve's exit certifies", () => {
  const library = new LdrawLibrary([PINNED_LIBRARY]);
  const markers = loadTrackEndMarkers();
  const plastic = buildTrackPiece(library, "53400", markers).piece;
  const nineVolt = buildTrackPiece(library, "74747", markers).piece;
  const chordAsPrinted = 2 * PLASTIC_END_X_AS_PRINTED;
  const chordOfR40 = 2 * R40_LDU * Math.sin(HALF_TURN_STEP_RADIANS);

  const [, plasticExit] = plastic.connectors;
  const [, nineVoltExit] = nineVolt.connectors;

  expect(plasticExit?.status).toBe("unverified");
  expect(plasticExit?.residualLdu).toBeCloseTo(chordAsPrinted - chordOfR40, PRINTED_DIGITS);
  expect(plasticExit?.residualLdu).toBeGreaterThan(CERTIFIED_RESIDUAL_LIMIT_LDU);
  expect(nineVoltExit?.status).toBe("certified");
  expect(nineVoltExit?.coefficients).toEqual(plasticExit?.coefficients);
});
