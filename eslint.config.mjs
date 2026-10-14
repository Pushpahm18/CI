import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  // Test fixtures (in-memory mock data) must never reach the running
  // application: only test files may import server/ci/testing/*.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/**/*.test.ts", "src/server/ci/testing/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/server/ci/testing/*", "**/server/ci/testing/*"],
              message: "Test fixtures (mock data) may only be imported by *.test.ts files.",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
