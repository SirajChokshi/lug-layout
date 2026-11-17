import { expect, it } from "vitest";
import { runningGearSpanProblem, type RunningGearSpan } from "./running-gear-span.ts";

it("accepts guides between the coupling faces and names the first thing wrong otherwise", () => {
  const cases: ReadonlyArray<readonly [RunningGearSpan, string | null]> = [
    [{ lengthLdu: 706, frontBogieLdu: 173, rearBogieLdu: 533 }, null],
    [{ lengthLdu: 706, frontBogieLdu: 0, rearBogieLdu: 706 }, null],
    [
      { lengthLdu: -10, frontBogieLdu: 173, rearBogieLdu: 533 },
      "the front coupling face must lie ahead of the rear one, but it is 10 LDU behind it",
    ],
    [
      { lengthLdu: 363, frontBogieLdu: -180, rearBogieLdu: 200 },
      "the front guide lies 180 LDU ahead of the front coupling face, outside the vehicle",
    ],
    [
      { lengthLdu: 706, frontBogieLdu: 173, rearBogieLdu: 710.5 },
      "the rear guide lies 4.5 LDU behind the rear coupling face, outside the vehicle",
    ],
    [
      { lengthLdu: 706, frontBogieLdu: 533, rearBogieLdu: 173 },
      "the front guide lies 360 LDU behind the rear guide",
    ],
    [
      { lengthLdu: Number.NaN, frontBogieLdu: 173, rearBogieLdu: 533 },
      "the coupling faces and guides must be finite numbers",
    ],
  ];
  for (const [span, problem] of cases) expect(runningGearSpanProblem(span)).toBe(problem);
});
