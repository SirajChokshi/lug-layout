import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import { noMathHypot } from "./no-math-hypot.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const flagged = [{ messageId: "planeHypot" }];

new RuleTester().run("no-math-hypot", noMathHypot, {
  valid: [
    { code: "export const d = planeHypot(dx, dz);", filename: "a.ts" },
    { code: "export const d = Math.hypot(dx, dy, dz);", filename: "a.ts" },
    { code: "export const d = Math.hypot(dx);", filename: "a.ts" },
    { code: "export const d = other.hypot(dx, dz);", filename: "a.ts" },
  ],
  invalid: [
    { code: "export const d = Math.hypot(dx, dz);", filename: "a.ts", errors: flagged },
    {
      code: "export const d = Math.hypot(a.x - b.x, a.z - b.z) * 20;",
      filename: "a.ts",
      errors: flagged,
    },
  ],
});
