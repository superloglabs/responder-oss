// The reset token is a single-use credential, so it is removed from the
// address before anything can record the URL.
export function takeResetPasswordToken(
  href: string,
  replaceUrl: (url: string) => void,
): string | null {
  const url = new URL(href);
  const token = url.searchParams.get("token");
  if (!token) return null;
  url.searchParams.delete("token");
  replaceUrl(url.toString());
  return token;
}
