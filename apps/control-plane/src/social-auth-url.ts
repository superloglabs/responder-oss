const oauthReturnParameters = ["error", "error_description", "signed_up"];

function cleanOAuthReturnUrl(currentUrl: string): URL {
  const url = new URL(currentUrl);
  for (const parameter of oauthReturnParameters) {
    url.searchParams.delete(parameter);
  }
  return url;
}

export function socialAuthUrls(currentUrl: string) {
  const returnUrl = cleanOAuthReturnUrl(currentUrl);
  const newUserUrl = new URL(returnUrl);
  newUserUrl.searchParams.set("signed_up", "1");

  return {
    callbackURL: returnUrl.toString(),
    errorCallbackURL: returnUrl.toString(),
    newUserCallbackURL: newUserUrl.toString(),
  };
}

export function socialAuthErrorMessage(search: string): string | null {
  const error = new URLSearchParams(search).get("error");
  if (!error) return null;

  if (error === "email_not_found") {
    return "GitHub did not provide an email address. Try again after email access is enabled, or continue with Google or email.";
  }

  return "Social sign in failed. Please try again.";
}
