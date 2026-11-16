import { defineRule } from "@oxlint/plugins";

export const noComments = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Disallow all code comments, including directives." },
    messages: { banned: "Code comments are not allowed in this repository." },
    schema: [],
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (comment.type === "Shebang") continue;
          context.report({ node: comment, messageId: "banned" });
        }
      },
    };
  },
});
