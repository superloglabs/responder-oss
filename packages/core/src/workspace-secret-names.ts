const workspaceSecretEnvironmentVariablePattern = /^[A-Z_][A-Z0-9_]*$/;

const reservedWorkspaceSecretEnvironmentVariables = new Set([
  "ALL_PROXY",
  "BASH_ENV",
  "ENV",
  "HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LANG",
  "LC_ALL",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "LOGNAME",
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NO_PROXY",
  "OLDPWD",
  "PATH",
  "PROMPT_COMMAND",
  "PWD",
  "PYTHONHOME",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PERL5LIB",
  "PERL5OPT",
  "RUBYLIB",
  "RUBYOPT",
  "SHELL",
  "SHLVL",
  "SSH_ASKPASS",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "_JAVA_OPTIONS",
]);

const reservedWorkspaceSecretEnvironmentVariablePrefixes = [
  "DAYTONA_",
  "DYLD_",
  "GIT_",
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
