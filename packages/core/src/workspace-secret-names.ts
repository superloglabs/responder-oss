const workspaceSecretEnvironmentVariablePattern = /^[A-Z_][A-Z0-9_]*$/;

const reservedWorkspaceSecretEnvironmentVariables = new Set([
  "ALL_PROXY",
  "BASH_ENV",
  "DYLD_INSERT_LIBRARIES",
  "ENV",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_ASKPASS",
  "GIT_COMMON_DIR",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_SYSTEM",
  "GIT_DIR",
  "GIT_EXEC_PATH",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_WORK_TREE",
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

export function workspaceSecretEnvironmentVariableNameReservation(
  name: string,
): string | null {
  return reservedWorkspaceSecretEnvironmentVariables.has(name)
    ? `${name} controls the sandbox runtime; choose a credential-specific environment variable name`
    : null;
}

export function isWorkspaceSecretEnvironmentVariableName(
  name: string,
): boolean {
  return (
    name.length <= 80 &&
    workspaceSecretEnvironmentVariablePattern.test(name) &&
    workspaceSecretEnvironmentVariableNameReservation(name) === null
  );
}
