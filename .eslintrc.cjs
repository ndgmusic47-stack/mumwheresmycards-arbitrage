/**
 * Minimal ESLint config for `pnpm lint` (root script: `eslint . --ext .ts,.tsx`).
 *
 * STABILISATION item 12 requires `pnpm lint` to pass before completion can
 * be declared, but this repo never had an ESLint config committed at all —
 * `eslint` and `@typescript-eslint/{eslint-plugin,parser}` were already
 * installed as devDependencies (package.json), just never wired up, so
 * `pnpm lint` failed outright with "ESLint couldn't find a configuration
 * file" regardless of code quality. This is deliberately unopinionated
 * (recommended rules only, no type-aware linting, no stylistic rules that
 * would force reformatting the existing codebase) — it exists so the lint
 * gate actually runs, not to impose a new style.
 */
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
    ecmaFeatures: { jsx: true },
  },
  plugins: ["@typescript-eslint"],
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  env: { es2022: true, node: true, browser: true },
  ignorePatterns: ["**/dist/**", "**/node_modules/**", "**/.wrangler/**", "**/coverage/**"],
  rules: {
    // TypeScript's own compiler (pnpm typecheck) already catches unused
    // imports/vars with full type information; the ESLint version has a
    // high false-positive rate on this codebase's type-only imports and
    // destructured-but-intentionally-unused args, so it's relaxed rather
    // than disabled outright.
    "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    "@typescript-eslint/no-explicit-any": "off",
    "no-empty": ["error", { allowEmptyCatch: true }],
  },
};
