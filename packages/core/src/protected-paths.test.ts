import { describe, expect, it } from "vitest";
import {
  protectedPathCategory,
  protectedPathsMessage,
  refusedProtectedPaths,
} from "./protected-paths.js";

describe("protected repository paths", () => {
  it.each([
    ".github/workflows/ci.yml",
    ".github/actions/setup/action.yml",
    ".github/dependabot.yml",
    ".github/CODEOWNERS",
    ".GitHub/Workflows/Deploy.yaml",
    ".gitlab-ci.yml",
    ".gitlab/ci/build.yml",
    ".circleci/config.yml",
    "Jenkinsfile",
    "ci/Jenkinsfile",
    ".buildkite/pipeline.yml",
    "azure-pipelines.yml",
    "bitbucket-pipelines.yml",
    ".pre-commit-config.yaml",
    ".husky/pre-commit",
    ".gitlab-ci.yaml",
    ".travis.yml",
    ".drone.yml",
    ".cirrus.yml",
    "appveyor.yml",
    "cloudbuild.yaml",
    "buildspec.yml",
    ".semaphore/semaphore.yml",
    ".woodpecker/build.yml",
    ".woodpecker.yml",
    "Dockerfile",
    "services/api/Dockerfile.prod",
    "web.dockerfile",
    "Containerfile",
  ])("treats %s as CI configuration", (path) => {
    expect(protectedPathCategory(path)).toBe("ci");
  });

  it.each([
    "package.json",
    "apps/web/package.json",
    "pnpm-lock.yaml",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "bun.lockb",
    "bun.lock",
    ".npmrc",
    ".yarnrc.yml",
    ".yarnrc",
    "pnpm-workspace.yaml",
    "requirements.txt",
    "requirements-dev.txt",
    "services/api/requirements/base.txt",
    "pyproject.toml",
    "poetry.lock",
    "uv.lock",
    "Pipfile",
    "Pipfile.lock",
    "setup.py",
    "setup.cfg",
    "go.mod",
    "go.sum",
    "Cargo.toml",
    "crates/core/Cargo.lock",
    "Gemfile",
    "Gemfile.lock",
    "composer.json",
    "composer.lock",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle.kts",
    "gradle.lockfile",
    "mix.exs",
    "mix.lock",
    "src/App/App.csproj",
    "packages.lock.json",
    "Directory.Packages.props",
    "mise.toml",
    ".mise.toml",
    ".tool-versions",
    ".pnpmfile.cjs",
    "pip.conf",
    "nuget.config",
    "environment.yml",
    "envs/environment.yaml",
    ".nvmrc",
    ".node-version",
    ".python-version",
    ".ruby-version",
    "pubspec.yaml",
    "pubspec.lock",
    "Package.swift",
    "Package.resolved",
    "build.sbt",
    "deno.json",
    "deno.jsonc",
    "deno.lock",
    "flake.nix",
    "flake.lock",
    "mylib.gemspec",
    "gradle/libs.versions.toml",
    "Directory.Build.props",
  ])("treats %s as a dependency file", (path) => {
    expect(protectedPathCategory(path)).toBe("dependencies");
  });

  it.each([
    "AGENTS.md",
    "packages/api/AGENTS.md",
    "CLAUDE.md",
    "docs/claude.md",
    ".claude/settings.json",
    ".claude/skills/deploy/SKILL.md",
    ".agents/skills/release/SKILL.md",
    ".cursor/rules/style.mdc",
    ".cursorrules",
    ".github/copilot-instructions.md",
    "CLAUDE.local.md",
    "GEMINI.md",
    ".windsurfrules",
    ".clinerules",
  ])("treats %s as agent instructions", (path) => {
    // The Copilot file sits under .github but is named for what it is.
    expect(protectedPathCategory(path)).toBe("agent_instructions");
  });

  it.each([
    "src/index.ts",
    "README.md",
    "docs/github-actions.md",
    "src/package.json.ts",
    "tests/fixtures/requirements.md",
    "src/agents/planner.ts",
    "docs/dockerfile-guide.md",
    "config/environment.ts",
  ])("allows %s", (path) => {
    expect(protectedPathCategory(path)).toBeNull();
  });

  it("normalizes leading ./ and repeated slashes", () => {
    expect(protectedPathCategory("./.github//workflows/ci.yml")).toBe("ci");
    expect(protectedPathCategory("apps\\web\\package.json")).toBe("dependencies");
  });

  it("refuses dependency files unless the automation allows them, and never CI or agent instructions", () => {
    const paths = ["src/fix.ts", "package.json", ".github/workflows/ci.yml", "AGENTS.md"];
    expect(refusedProtectedPaths(paths)).toEqual([
      { category: "dependencies", path: "package.json" },
      { category: "ci", path: ".github/workflows/ci.yml" },
      { category: "agent_instructions", path: "AGENTS.md" },
    ]);
    expect(refusedProtectedPaths(paths, { allowDependencyChanges: true })).toEqual([
      { category: "ci", path: ".github/workflows/ci.yml" },
      { category: "agent_instructions", path: "AGENTS.md" },
    ]);
  });

  it("tells the agent which files were refused and what to do instead", () => {
    const message = protectedPathsMessage([
      { category: "ci", path: ".github/workflows/ci.yml" },
      { category: "dependencies", path: "package.json" },
    ]);
    expect(message).toContain(".github/workflows/ci.yml (CI configuration)");
    expect(message).toContain("package.json (dependencies)");
    expect(message).toMatch(/Undo the changes to these files/u);
    expect(message).toMatch(/describe .* for a person to make/u);
  });

  it("keeps the message short when many files are refused", () => {
    const refused = Array.from({ length: 40 }, (_, index) => ({
      category: "dependencies" as const,
      path: `packages/p${index}/package.json`,
    }));
    const message = protectedPathsMessage(refused);
    expect(message.length).toBeLessThan(500);
    expect(message).toContain("and 35 more");
  });
});
