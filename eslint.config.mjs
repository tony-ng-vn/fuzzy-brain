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
    // Benchmark scratch: gitignored, so CI never sees these and neither should
    // a local lint run. They are throwaway readers the bench scripts write.
    "experiments/recall-bench/.out/**",
    "experiments/recall-bench/.data/**",
  ]),
]);

export default eslintConfig;
