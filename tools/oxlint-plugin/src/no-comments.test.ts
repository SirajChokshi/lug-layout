import { RuleTester } from "oxlint/plugins-dev";
import { describe, it } from "vitest";
import { noComments } from "./no-comments.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const banned = [{ messageId: "banned" }];

new RuleTester().run("no-comments", noComments, {
  valid: [
    { code: "export const url = 'https://example.com/a//b';", filename: "a.ts" },
    { code: "export const s = `/* not a comment */`;", filename: "a.ts" },
    { code: "export const r = /\\/\\//u;", filename: "a.ts" },
    { code: "#!/usr/bin/env node\nexport const x = 1;", filename: "cli.ts" },
  ],
  invalid: [
    { code: "export const x = 1; // trailing", filename: "a.ts", errors: banned },
    { code: "/* block */\nexport const x = 1;", filename: "a.ts", errors: banned },
    {
      code: "// @ts-expect-error\nexport const x: number = 'a';",
      filename: "a.ts",
      errors: banned,
    },
    { code: "export const X = () => <div>{/* jsx */}</div>;", filename: "a.tsx", errors: banned },
    {
      code: "// one\n// two\nexport const x = 1;",
      filename: "a.ts",
      errors: [...banned, ...banned],
    },
  ],
});
