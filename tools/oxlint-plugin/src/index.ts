import { definePlugin } from "@oxlint/plugins";
import { noComments } from "./no-comments.ts";
import { noMathHypot } from "./no-math-hypot.ts";

export const plugin = definePlugin({
  meta: { name: "brr" },
  rules: { "no-comments": noComments, "no-math-hypot": noMathHypot },
});

export default plugin;
