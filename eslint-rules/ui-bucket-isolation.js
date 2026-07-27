// @ts-check
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * src/ui has three buckets and the two ends never meet:
 *
 *   app/     the ground app — tabs, logbook, settings, sync, planning
 *   flight/  the in-flight surface, which replaces the whole shell in flight
 *   shared/  what both genuinely need (the map, the error screen, settings ctx)
 *
 * Allowed edges: within a bucket, and app|flight -> shared. Everything else is
 * an error, INCLUDING shared -> app|flight (shared reaching back into a bucket
 * makes it a laundering layer that reconnects the two ends) and any bucket
 * importing a file at the root of src/ui (nothing may import the switch).
 *
 * src/ui/App.tsx is the only file allowed to see both, because it IS the
 * switch. That exemption is by exact path: "anything not in a bucket" would
 * make `src/ui/Anything.ts` a permanent escape hatch.
 *
 * Resolved paths, not specifier globs: `src/flight/` (flight LOGIC, shared by
 * everyone) and `src/ui/flight/` (flight UI) both end in "/flight/", so a glob
 * on the import string cannot tell them apart and would ban the wrong one.
 *
 * Anchored to this file, not to context.cwd: cwd follows however eslint was
 * invoked, so a run from a subdirectory silently disabled the whole rule.
 */

const REPO = resolve(import.meta.dirname, "..");
const UI = join(REPO, "src/ui");
const SWITCH = join(UI, "App.tsx");
const BUCKETS = ["app", "flight", "shared"];

/** app | flight | shared | root (a file directly under src/ui) | null. */
function bucketOf(file) {
  const rel = relative(UI, file);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  const head = rel.split(sep)[0];
  return BUCKETS.includes(head) ? head : "root";
}

function forbids(from, to) {
  if (!to || from === to) return false;
  if (to === "shared") return false;
  return true;
}

/** A specifier the module graph really follows: "x" and `x`, but not `${x}`. */
function literalSource(node) {
  if (!node) return null;
  if (node.type === "Literal") {
    return typeof node.value === "string" ? node.value : null;
  }
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? null;
  }
  return null;
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
      launder:
        "src/ui/shared may not import src/ui/{{to}}. Shared is what BOTH " +
        "buckets can use; reaching back into one reconnects them.",
      switchOnly:
        "Nothing may import src/ui/App.tsx — it is the switch between the " +
        "buckets, not a module to reuse.",
    },
  },
  create(context) {
    const here = bucketOf(context.filename);
    if (here === null || context.filename === SWITCH) return {};

    function check(node, raw) {
      const spec = literalSource(raw ?? node);
      if (typeof spec !== "string" || !spec.startsWith(".")) return;
      const target = resolve(dirname(context.filename), spec);
      const to = bucketOf(target);
      if (!forbids(here, to)) return;
      const messageId =
        to === "root"
          ? "switchOnly"
          : here === "shared"
            ? "launder"
            : "crossed";
      context.report({ node, messageId, data: { from: here, to } });
    }

    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => node.source && check(node.source),
      ExportAllDeclaration: (node) => node.source && check(node.source),
      ImportExpression: (node) => check(node.source),
      // vi.mock("../flight/x") couples a test to the other bucket just as
      // firmly as an import, and is invisible to every other check here.
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type === "MemberExpression" &&
          callee.object.type === "Identifier" &&
          callee.object.name === "vi" &&
          callee.property.type === "Identifier" &&
          /^(mock|importActual|importMock)$/.test(callee.property.name)
        ) {
          check(node.arguments[0], node.arguments[0]);
        }
      },
    };
  },
};
