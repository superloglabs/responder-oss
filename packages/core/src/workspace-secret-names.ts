const workspaceSecretEnvironmentVariablePattern = /^[A-Z_][A-Z0-9_]*$/;

const reservedWorkspaceSecretEnvironmentVariables = new Set([
  "ALL_PROXY",
  "BASH_ENV",
  "ENV",
  "GIT_ASKPASS",
  "GIT_SSH_COMMAND",
  "HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LANG",
  "LC_ALL",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "LOGNAME",
  "NODE_OPTIONS",
  "NO_PROXY",
  "OLDPWD",
  "PATH",
  "PROMPT_COMMAND",
  "PWD",
  "PYTHONPATH",
  "SHELL",
  "SHLVL",
  "SSH_ASKPASS",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
]);

const reservedWorkspaceSecretEnvironmentVariablePrefixes = [
  "DAYTONA_",
  "DYLD_",
  "GIT_CONFIG_",
  "NPM_CONFIG_",
  "OPENAI_",
  "PNPM_",
  "RESPONDER_",
];

export function isWorkspaceSecretEnvironmentVariableName(
  name: string,
): boolean {
  return (
    name.length <= 80 &&
    workspaceSecretEnvironmentVariablePattern.test(name) &&
    !reservedWorkspaceSecretEnvironmentVariables.has(name) &&
    !reservedWorkspaceSecretEnvironmentVariablePrefixes.some((prefix) =>
      name.startsWith(prefix),
    )
  );
}
