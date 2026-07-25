// @ts-check

/**
 * `{cond && <X />}` is fine when `cond` is a single named guard — that reads
 * as "render this when that". It stops reading the moment the condition
 * itself is logic: `{a && b.c && <X />}` and `{n > 0 && <X />}` bury a
 * decision inside a render position, where it cannot be named, cannot be
 * tested, and grows one `&&` at a time until the JSX is the state machine.
 *
 * The fix is never a bigger expression. Either name the boolean next to the
 * other derived state, or lift the branch into a function that returns early
 * — the same shape the rest of the flight surface uses for its states.
 *
 * Legal left sides: an identifier, a member/optional-member read, a call, a
 * negation. Illegal: `&&`/`||` chains and inline comparisons. Only JSX CHILD
 * positions are judged; `disabled={a && b}` is an ordinary boolean prop and
 * is left alone.
 */

/** Unwrap the nodes that only add syntax, never a branch. */
function core(node) {
  let current = node;
  for (;;) {
    switch (current.type) {
      case "ChainExpression":
      case "TSNonNullExpression":
      case "TSAsExpression":
      case "TSSatisfiesExpression":
        current = current.expression;
        break;
      default:
        return current;
    }
  }
}

/** @type {import("eslint").Rule.RuleModule} */
export default {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Allow `{cond && <X />}` only when cond is a single named guard",
    },
    schema: [],
    messages: {
      composite:
        "Composite `&&` condition rendering JSX. Name the boolean " +
        "(`const canFoo = a && b;`) or extract a render function with early " +
        "returns; `{cond && <X />}` is for one named guard.",
      comparison:
        "Inline comparison rendering JSX. Name the boolean " +
        '(`const isFoo = status === "foo";`) or extract a render function ' +
        "with early returns; `{cond && <X />}` is for one named guard.",
    },
  },
  create(context) {
    return {
      "JSXElement > JSXExpressionContainer > LogicalExpression, JSXFragment > JSXExpressionContainer > LogicalExpression"(
        node,
      ) {
        if (node.operator !== "&&") return;
        const left = core(node.left);
        switch (left.type) {
          case "LogicalExpression":
            context.report({ node: left, messageId: "composite" });
            return;
          case "BinaryExpression":
            context.report({ node: left, messageId: "comparison" });
            return;
          default:
            return;
        }
      },
    };
  },
};
