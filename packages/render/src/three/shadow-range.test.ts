import { describe, expect, it } from "vitest";
import { SHADOW_FAR_HYSTERESIS, ShadowRange } from "./shadow-range.ts";

const SETTLED_NEEDED_LDU = 44_911.5;

function rangesAfter(neededs: ReadonlyArray<number>): number[] {
  const range = new ShadowRange();
  return neededs.map((needed) => {
    range.fit(needed);
    return range.far;
  });
}

describe("ShadowRange", () => {
  it.each([
    {
      path: "session A's fit-all tween",
      neededs: [24_314.3, 19_144, 33_618.4, 43_030.8],
      atRestOnArrival: false,
    },
    {
      path: "session B's fit-all tween",
      neededs: [24_314.3, 18_240.1, 33_557.6, 44_056.8],
      atRestOnArrival: false,
    },
    { path: "an approach from far away", neededs: [90_000, 70_000, 50_000], atRestOnArrival: true },
  ])(
    "rests at the range the settled view needs, whatever path led there: $path",
    ({ neededs, atRestOnArrival }) => {
      const range = new ShadowRange();
      for (const needed of [...neededs, SETTLED_NEEDED_LDU]) range.fit(needed);
      const arrived = range.atRest;
      range.fit(SETTLED_NEEDED_LDU);

      expect({ arrived, far: range.far, atRest: range.atRest }).toEqual({
        arrived: atRestOnArrival,
        far: SETTLED_NEEDED_LDU * SHADOW_FAR_HYSTERESIS,
        atRest: true,
      });
    },
  );

  it("keeps the range while the moving view's need stays within its band, and refits to the rest range when it leaves", () => {
    expect(rangesAfter([1000, 1100, 1250, 1251, 1300, 1000])).toEqual([
      1250,
      1250,
      1250,
      1251 * SHADOW_FAR_HYSTERESIS,
      1251 * SHADOW_FAR_HYSTERESIS,
      1000 * SHADOW_FAR_HYSTERESIS,
    ]);
  });

  it("doesn't flip while the moving view's need hovers at its band's edge", () => {
    const hovering = [1000, 1250, 1249, 1250, 1249, 1250];
    expect(rangesAfter(hovering)).toEqual(hovering.map(() => 1250));
  });

  it("is at rest only while its range is the rest range for the last needed range", () => {
    const range = new ShadowRange();
    range.fit(1000);
    const refit = range.atRest;
    range.fit(1100);
    const held = range.atRest;
    range.fit(1100);

    expect({ refit, held, rested: range.atRest }).toEqual({
      refit: true,
      held: false,
      rested: true,
    });
  });
});
