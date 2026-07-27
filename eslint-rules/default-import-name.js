// @ts-check

/**
 * A default import from a local module must be bound to that module's name.
 *
 * Renaming one splits a single component into two identities that neither grep
 * nor a reader can reconcile: `src/ui/flight/FlyPage` was rendered as
 * `<FlightSurface />` in App.tsx and as `<FlyPage />` in two other places, so
 * searching for either name found two thirds of the call sites, and the file
 * kept a name that no longer described it.
 *
 * This guards against DRIFT, not against a determined evader — a module can
 * always be renamed on both ends. That is the point: renaming both ends is a
 * decision, and this makes it one.
 *
 * Separators are ignored so a kebab-case module may bind to its camelCase
 * equivalent (a hyphen cannot be an identifier, and that mapping is
 * mechanical). CASE IS NOT ignored for the first character, because case is
 * load-bearing in this codebase: `UseLatestFlight` would silence
 * react-hooks/rules-of-hooks, and `mapCanvas` is an unknown DOM element rather
 * than a component.
 *
 * Package imports are exempt (renaming a dependency's default is ordinary), as
 * are assets and CSS modules, where `styles` is the convention.
 */

const ASSET = /\.(css|scss|svg|png|jpe?g|webp|gif|avif|json|txt|wasm|glsl)$/;
const SOURCE = /\.[cm]?[jt]sx?$/;

const letters = (name) => name.replace(/[^a-z0-9]/gi, "");
const sameShape = (local, expected) =>
  letters(local).toLowerCase() === letters(expected).toLowerCase() &&
  letters(local).charAt(0) === letters(expected).charAt(0);

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
        const raw = node.source.value;
        if (typeof raw !== "string" || !raw.startsWith(".")) return;
        // Vite carries build directives in a query: "./icon.svg?url".
        const source = raw.split("?")[0];
        if (ASSET.test(source)) return;

        // `import X from`, `import * as X from`, and `import { default as X }`
        // all bind the module's default under a name of the author's choosing.
        const specifier = node.specifiers.find(
          (s) =>
            s.type === "ImportDefaultSpecifier" ||
            s.type === "ImportNamespaceSpecifier" ||
            (s.type === "ImportSpecifier" &&
              s.imported.type === "Identifier" &&
              s.imported.name === "default"),
        );
        if (!specifier) return;

        // A directory import resolves to its index, so the directory name is
        // the module's name; "index" itself never is.
        const segments = source.split("/").filter(Boolean);
        const expected =
          segments[segments.length - 1]?.replace(SOURCE, "") ?? "";
        if (!expected || expected === "index" || expected === "..") return;
        if (sameShape(specifier.local.name, expected)) return;

        context.report({
          node: specifier,
          messageId: "renamed",
          data: { source: raw, local: specifier.local.name, expected },
        });
      },
    };
  },
};
