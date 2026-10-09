// A Slack trigger can ignore messages whose text matches any of its phrases.
// Each phrase is a regular expression, matched case-insensitively anywhere in
// the message text as Slack sends it, so plain words match as written.

export const maxSlackPhrases = 50;
export const maxSlackPhraseLength = 500;
export const slackPhraseFlags = "iu";

// Why a phrase cannot be saved, or null when it can.
export function slackPhraseError(phrase: string): string | null {
  if (!phrase.trim()) return "Enter a phrase.";
  if (phrase.length > maxSlackPhraseLength) return `Use ${maxSlackPhraseLength} characters or fewer.`;
  try {
    new RegExp(phrase, slackPhraseFlags);
    return null;
  } catch {
    return `"${phrase}" is not a valid regular expression.`;
  }
}
