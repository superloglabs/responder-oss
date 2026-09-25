import { globSync, readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";

const include = [
  "apps/**/*.test.ts",
  "packages/**/*.test.ts",
  "scripts/**/*.test.mjs",
];
const exclude = [
  "**/.eve/**",
  "**/.output/**",
  "**/dist/**",
  "**/node_modules/**",
];

// Loading a fresh module graph for every file is most of the suite's runtime.
// Only files that replace modules or globals need that isolation; the rest
// share one module cache per worker.
const isolationPattern =
  /\bvi\.(mock|doMock|unmock|resetModules|stubGlobal|stubEnv)\(/;
const isolatedFiles = globSync(include, {
  cwd: import.meta.dirname,
  exclude,
}).filter((file) =>
  isolationPattern.test(
    readFileSync(path.join(import.meta.dirname, file), "utf8"),
  ),
);

export default defineConfig({
  test: {
    // Vitest defaults to one worker fewer than the CPU count, which leaves a
    // two-core CI runner on a single worker.
    maxWorkers: "100%",
    projects: [
      {
        test: { exclude, include: isolatedFiles, name: "isolated" },
      },
      {
        test: {
          exclude: [...exclude, ...isolatedFiles],
          include,
          isolate: false,
          name: "shared",
        },
      },
    ],
  },
});
