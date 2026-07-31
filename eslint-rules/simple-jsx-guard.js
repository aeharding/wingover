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
 * Legal condition: an identifier, a member/optional-member read, a call, a
 * negation. Illegal: more than one condition, an `&&`/`||` chain as the
 * condition, or an inline comparison. The `&&` tree is FLATTENED first, so
 * `{a && (b && <X />)}` is judged as the two conditions it is rather than
 * escaping down the right spine.
 *
 * Only JSX CHILD positions are judged; `disabled={a && b}` is an ordinary
 * boolean prop and is left alone.
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

/** Every operand of an `&&` tree, in source order. */
function flatten(node, out) {
  const current = core(node);
  if (current.type === "LogicalExpression" && current.operator === "&&") {
    flatten(current.left, out);
    flatten(current.right, out);
    return out;
  }
  out.push(current);
  return out;
}

/**
 * "composite" | "comparison" | null — what is wrong with these conditions,
 * if anything. One plain guard is the only legal shape.
 */
function verdict(conditions) {
  if (conditions.length > 1) return "composite";
  const only = conditions[0];
  if (!only) return null;
  switch (only.type) {
    case "LogicalExpression":
      return "composite";
    case "BinaryExpression":
      return "comparison";
    default:
      return null;
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
        "Composite condition rendering JSX. Name the boolean " +
        "(`const canFoo = a && b;`) or extract a render function with early " +
        "returns; `{cond && <X />}` is for one named guard.",
      comparison:
        "Inline comparison rendering JSX. Name the boolean " +
        '(`const isFoo = status === "foo";`) or extract a render function ' +
        "with early returns; `{cond && <X />}` is for one named guard.",
    },
  },
  create(context) {
    function check(node, conditions) {
      const messageId = verdict(conditions);
      if (messageId) context.report({ node, messageId });
    }

    return {
      // The `&&` form. Only the top of the chain is a direct child of the
      // container; flatten() reaches the rest.
      "JSXElement > JSXExpressionContainer > LogicalExpression, JSXFragment > JSXExpressionContainer > LogicalExpression"(
        node,
      ) {
        if (node.operator !== "&&") return;
        const parts = flatten(node, []);
        // The last operand is what gets rendered; the rest are the guard.
        check(node, parts.slice(0, -1));
      },
      // The ternary form. `{n > 0 ? <X /> : null}` is the same decision in
      // the same place, and would otherwise be the way around the rule.
      "JSXElement > JSXExpressionContainer > ConditionalExpression, JSXFragment > JSXExpressionContainer > ConditionalExpression"(
        node,
      ) {
        check(node, flatten(node.test, []));
      },
    };
  },
};
