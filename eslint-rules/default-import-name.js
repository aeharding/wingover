// @ts-check

/**
 * A default import from a local module must be bound to that module's name.
 *
 * Renaming one splits a single component into two identities that neither
 * grep nor a reader can reconcile: `src/ui/flight/FlyPage` was rendered as
 * `<FlightSurface />` in App.tsx and as `<FlyPage />` in two other places, so
 * searching for either name found two thirds of the call sites, and the file
 * kept a name that no longer described it.
 *
 * Case and separators are ignored, so a kebab-case module may be bound to its
 * camelCase equivalent — a hyphen cannot be an identifier, and that mapping is
 * mechanical. A genuinely different word is still caught.
 *
 * Package imports are exempt (renaming a dependency's default is ordinary),
 * as are assets and CSS modules, where `styles` is the convention.
 */

const ASSET = /\.(css|scss|svg|png|jpe?g|webp|gif|avif|json|txt|wasm|glsl)$/;
const SOURCE = /\.[jt]sx?$/;

const normalize = (name) => name.replace(/[^a-z0-9]/gi, "").toLowerCase();

/** @type {import("eslint").Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description: "Default imports of local modules keep the module's name",
    },
    schema: [],
    messages: {
      renamed:
        'Default import of "{{source}}" is bound to "{{local}}". Name it ' +
        '"{{expected}}", or rename the module to match what it is.',
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        const source = node.source.value;
        if (typeof source !== "string" || !source.startsWith(".")) return;
        if (ASSET.test(source)) return;

        const specifier = node.specifiers.find(
          (s) => s.type === "ImportDefaultSpecifier",
        );
        if (!specifier) return;

        // A directory import resolves to its index, so the directory name is
        // the module's name; "index" itself never is.
        const expected = source.split("/").pop()?.replace(SOURCE, "") ?? "";
        if (!expected || expected === "index") return;
        if (normalize(specifier.local.name) === normalize(expected)) return;

        context.report({
          node: specifier,
          messageId: "renamed",
          data: { source, local: specifier.local.name, expected },
        });
      },
    };
  },
};
