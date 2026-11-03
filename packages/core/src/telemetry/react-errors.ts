import { reactErrorMessages } from "./react-error-codes.js";

// Production React replaces each error message with its code and a link, such
// as "Minified React error #418; visit https://react.dev/errors/418?args[]=HTML
// ...". Issues show the message React would have thrown in development.

export const minifiedMessageAttribute = "exception.message.minified";

const minifiedReactError =
  /Minified React error #(\d+); visit (\S+) for the full message(?: or use the non-minified dev environment for full errors and additional helpful warnings)?\.?/u;

function argumentsOf(link: string): string[] {
  try {
    return new URL(link).searchParams.getAll("args[]");
  } catch {
    return [];
  }
}

// The message with React's text in place of the code, or null when it holds
// no React error code this table knows.
export function decodeReactError(message: string): string | null {
  const match = minifiedReactError.exec(message);
  const template = match ? reactErrorMessages[match[1]!] : undefined;
  if (!match || !template) return null;
  const args = argumentsOf(match[2]!);
  let next = 0;
  const decoded = template.replace(/%s/gu, () => args[next++] ?? "");
  return `${message.slice(0, match.index)}${decoded}${message.slice(match.index + match[0].length)}`;
}
