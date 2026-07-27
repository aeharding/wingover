// @ts-check
import { dirname, relative, resolve, sep } from "node:path";

/**
 * src/ui has exactly three buckets and the two ends never meet:
 *
 *   app/     the ground app — tabs, logbook, settings, sync, planning
 *   flight/  the in-flight surface, which replaces the whole shell in flight
 *   shared/  what both genuinely need (the map, the error screen, settings ctx)
 *
 * app and flight may not import each other. Anything they both want moves to
 * shared, deliberately, rather than one reaching into the other and quietly
 * coupling the ground app to the surface a pilot's life runs on.
 *
 * Resolved paths, not specifier globs: `src/flight/` (flight LOGIC, shared by
 * everyone) and `src/ui/flight/` (flight UI) both end in "/flight/", so a glob
 * on the import string cannot tell them apart and would ban the wrong one.
 *
 * src/ui/App.tsx is the one exception — it is the switch that chooses between
 * the two, so it necessarily sees both.
 */

const BUCKETS = ["app", "flight", "shared"];

function bucketOf(file, root) {
  const rel = relative(resolve(root, "src/ui"), file);
  if (rel.startsWith("..")) return null;
  const head = rel.split(sep)[0];
  return BUCKETS.includes(head) ? head : null;
}

/** @type {import("eslint").Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description: "src/ui/app and src/ui/flight may not import each other",
    },
    schema: [],
    messages: {
      crossed:
        "src/ui/{{from}} may not import src/ui/{{to}}. These two never meet: " +
        "move what both need into src/ui/shared.",
    },
  },
  create(context) {
    const root = context.cwd;
    const here = bucketOf(context.filename, root);
    if (here !== "app" && here !== "flight") return {};
    const forbidden = here === "app" ? "flight" : "app";

    function check(node, value) {
      if (typeof value !== "string" || !value.startsWith(".")) return;
      const target = resolve(dirname(context.filename), value);
      if (bucketOf(target, root) !== forbidden) return;
      context.report({
        node,
        messageId: "crossed",
        data: { from: here, to: forbidden },
      });
    }

    return {
      ImportDeclaration: (node) => check(node.source, node.source.value),
      ExportNamedDeclaration: (node) =>
        node.source && check(node.source, node.source.value),
      ExportAllDeclaration: (node) =>
        node.source && check(node.source, node.source.value),
      ImportExpression: (node) =>
        node.source.type === "Literal" && check(node.source, node.source.value),
    };
  },
};
