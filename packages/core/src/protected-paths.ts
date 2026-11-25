// Files an agent may not change in a pull request it publishes. A pushed
// branch runs the repository's CI before anyone reviews it, and CI runs the
// pipeline definitions, installs the declared dependencies, and runs their
// install scripts. Agent instruction files steer every later agent run in the
// repository. Changes to these files are left to people.
export type ProtectedPathCategory = "agent_instructions" | "ci" | "dependencies";

export interface RefusedProtectedPath {
  category: ProtectedPathCategory;
  path: string;
}

const categoryLabels: Record<ProtectedPathCategory, string> = {
  agent_instructions: "agent instructions",
  ci: "CI configuration",
  dependencies: "dependencies",
};

// Directories whose every file is protected, as lower-case path segments.
const ciDirectories = [".github", ".gitlab", ".circleci", ".buildkite", ".husky", ".semaphore", ".woodpecker"];
const agentInstructionDirectories = [".claude", ".cursor", ".agents", ".clinerules", ".windsurf", ".gemini"];

const ciFileNames = new Set([
  ".gitlab-ci.yml",
  ".gitlab-ci.yaml",
  "jenkinsfile",
  "azure-pipelines.yml",
  "azure-pipelines.yaml",
  "bitbucket-pipelines.yml",
  ".pre-commit-config.yaml",
  ".pre-commit-config.yml",
  ".travis.yml",
  ".drone.yml",
  ".cirrus.yml",
  ".woodpecker.yml",
  "appveyor.yml",
  "cloudbuild.yaml",
  "cloudbuild.yml",
  "cloudbuild.json",
  "buildspec.yml",
  "buildspec.yaml",
]);

const agentInstructionFileNames = new Set([
  "agents.md",
  "claude.md",
  ".cursorrules",
  "copilot-instructions.md",
  "claude.local.md",
  "gemini.md",
  ".windsurfrules",
  ".clinerules",
]);

const dependencyFileNames = new Set([
  // JavaScript
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pnpmfile.cjs",
  // Python
  "pyproject.toml",
  "poetry.lock",
  "uv.lock",
  "pipfile",
  "pipfile.lock",
  "setup.py",
  "setup.cfg",
  "pip.conf",
  "environment.yml",
  "environment.yaml",
  // Go, Rust, Ruby, PHP, Elixir
  "go.mod",
  "go.sum",
  "go.work",
  "cargo.toml",
  "cargo.lock",
  "gemfile",
  "gemfile.lock",
  "composer.json",
  "composer.lock",
  "mix.exs",
  "mix.lock",
  // Dart, Swift, Scala, Deno, Nix
  "pubspec.yaml",
  "pubspec.lock",
  "package.swift",
  "package.resolved",
  "build.sbt",
  "deno.json",
  "deno.jsonc",
  "deno.lock",
  "flake.nix",
  "flake.lock",
  // JVM
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "gradle.lockfile",
  "libs.versions.toml",
  // .NET
  "packages.lock.json",
  "directory.packages.props",
  "directory.build.props",
  "nuget.config",
  // Runtime versions, which tool managers install
  "mise.toml",
  ".mise.toml",
  ".tool-versions",
  ".nvmrc",
  ".node-version",
  ".python-version",
  ".ruby-version",
]);

function normalizedSegments(path: string): string[] {
  return path
    .replaceAll("\\", "/")
    .toLowerCase()
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
}

function isRequirementsFile(segments: string[]): boolean {
  const name = segments.at(-1) ?? "";
  if (/^requirements([._-].*)?\.(txt|in)$/u.test(name)) return true;
  // requirements/base.txt
  return segments.length >= 2 && segments.at(-2) === "requirements" && /\.(txt|in)$/u.test(name);
}

// Container builds run their steps in CI.
function isDockerfile(name: string): boolean {
  return ["dockerfile", "containerfile"].some((base) =>
    name === base || name.startsWith(`${base}.`) || name.endsWith(`.${base}`)
  );
}

// What kind of protected file the repository path is, or null when the agent
// may change it. Matching ignores case.
export function protectedPathCategory(path: string): ProtectedPathCategory | null {
  const segments = normalizedSegments(path);
  const name = segments.at(-1);
  if (!name) return null;
  if (agentInstructionFileNames.has(name)) return "agent_instructions";
  if (segments.slice(0, -1).some((segment) => agentInstructionDirectories.includes(segment))) {
    return "agent_instructions";
  }
  if (ciFileNames.has(name) || isDockerfile(name)) return "ci";
  if (segments.slice(0, -1).some((segment) => ciDirectories.includes(segment))) return "ci";
  if (
    dependencyFileNames.has(name) ||
    [".csproj", ".fsproj", ".vbproj"].some((extension) => name.endsWith(extension)) ||
    name.endsWith(".gemspec") ||
    isRequirementsFile(segments)
  ) {
    return "dependencies";
  }
  return null;
}

// The changed paths a published pull request may not include. Dependency
// files are allowed only when the automation allows them; CI configuration
// and agent instructions never are.
export function refusedProtectedPaths(
  paths: Iterable<string>,
  options: { allowDependencyChanges?: boolean } = {},
): RefusedProtectedPath[] {
  const refused: RefusedProtectedPath[] = [];
  for (const path of paths) {
    const category = protectedPathCategory(path);
    if (!category) continue;
    if (category === "dependencies" && options.allowDependencyChanges) continue;
    refused.push({ category, path });
  }
  return refused;
}

const maxListedPaths = 5;

// The error the agent reads, short enough to reach it whole.
export function protectedPathsMessage(refused: RefusedProtectedPath[]): string {
  const listed = refused
    .slice(0, maxListedPaths)
    .map(({ category, path }) => `${path} (${categoryLabels[category]})`);
  const more = refused.length > maxListedPaths ? `, and ${refused.length - maxListedPaths} more` : "";
  return [
    `Agents cannot change these files: ${listed.join(", ")}${more}.`,
    "Undo the changes to these files and publish again.",
    "If the fix needs them, describe the change in the pull request body or your reply for a person to make.",
  ].join(" ");
}

export class ProtectedPathsError extends Error {
  readonly refused: RefusedProtectedPath[];

  constructor(refused: RefusedProtectedPath[]) {
    super(protectedPathsMessage(refused));
    this.name = "ProtectedPathsError";
    this.refused = refused;
  }
}

// Throws when the changes include files the agent may not change.
export function assertNoProtectedPaths(
  paths: Iterable<string>,
  options: { allowDependencyChanges?: boolean } = {},
): void {
  const refused = refusedProtectedPaths(paths, options);
  if (refused.length > 0) throw new ProtectedPathsError(refused);
}
