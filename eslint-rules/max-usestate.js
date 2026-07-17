// @ts-check

/**
 * A component juggling more than five useState calls is a design smell:
 * related state wants a hook, an object, or a reducer. Custom hooks are
 * counted separately (per enclosing function), so extraction is the fix,
 * not a workaround.
 */
const MAX = 5;

/** @type {import("eslint").Rule.RuleModule} */
export default {
  meta: {
    type: "suggestion",
    docs: {
      description: `Limit useState calls to ${MAX} per function`,
    },
    schema: [],
    messages: {
      tooMany:
        "{{count}} useState calls in one function (max {{max}}). " +
        "Group related state or extract a custom hook.",
    },
  },
  create(context) {
    /** @type {{ node: import("estree").Node; count: number }[]} */
    const stack = [];

    function enter(node) {
      stack.push({ node, count: 0 });
    }

    function exit() {
      const frame = stack.pop();
      if (frame && frame.count > MAX) {
        context.report({
          node: frame.node,
          messageId: "tooMany",
          data: { count: String(frame.count), max: String(MAX) },
        });
      }
    }

    return {
      FunctionDeclaration: enter,
      "FunctionDeclaration:exit": exit,
      FunctionExpression: enter,
      "FunctionExpression:exit": exit,
      ArrowFunctionExpression: enter,
      "ArrowFunctionExpression:exit": exit,
      CallExpression(node) {
        const callee = node.callee;
        const isUseState =
          (callee.type === "Identifier" && callee.name === "useState") ||
          (callee.type === "MemberExpression" &&
            callee.property.type === "Identifier" &&
            callee.property.name === "useState");
        if (isUseState && stack.length > 0) {
          stack[stack.length - 1].count += 1;
        }
      },
    };
  },
};
