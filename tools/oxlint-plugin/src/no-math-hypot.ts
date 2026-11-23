import { defineRule } from "@oxlint/plugins";

const PLANE_ARGUMENTS = 2;

export const noMathHypot = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow two-argument Math.hypot where planeHypot from @brr/math applies.",
    },
    messages: {
      planeHypot:
        "Two-argument Math.hypot allocates on every call; use planeHypot from @brr/math, which gives the same bits.",
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression" || callee.computed) return;
        if (callee.object.type !== "Identifier" || callee.object.name !== "Math") return;
        if (callee.property.type !== "Identifier" || callee.property.name !== "hypot") return;
        if (node.arguments.length !== PLANE_ARGUMENTS) return;
        context.report({ node, messageId: "planeHypot" });
      },
    };
  },
});
