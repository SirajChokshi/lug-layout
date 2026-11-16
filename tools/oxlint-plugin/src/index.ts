import { definePlugin } from "@oxlint/plugins";
import { noComments } from "./no-comments.ts";

export const plugin = definePlugin({
  meta: { name: "brr" },
  rules: { "no-comments": noComments },
});

export default plugin;
