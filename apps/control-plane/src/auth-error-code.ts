interface AuthErrorLike {
  code?: string;
  status?: number;
}

export function authErrorCode(
  error: AuthErrorLike | null | undefined,
  fallback = "unknown",
): string {
  return error?.code ?? (error?.status ? String(error.status) : fallback);
}
