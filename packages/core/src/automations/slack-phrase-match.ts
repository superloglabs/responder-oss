import { createContext, Script } from "node:vm";
import { slackPhraseFlags } from "./slack-phrases.js";

// Members write these expressions, and one that backtracks without end would
// hold the event loop for every organization. The VM stops a match that runs
// past the timeout.
const matchTimeoutMs = 50;
const matchContext = createContext({ flags: slackPhraseFlags, phrase: "", text: "" });
const matchScript = new Script("new RegExp(phrase, flags).test(text)");

// Whether the text matches any of the phrases. A phrase that fails to compile
// or runs past the timeout does not match.
export function matchesSlackPhrase(phrases: readonly string[], text: string): boolean {
  try {
    return phrases.some((phrase) => {
      matchContext.phrase = phrase;
      matchContext.text = text;
      try {
        return matchScript.runInContext(matchContext, { timeout: matchTimeoutMs }) === true;
      } catch (error) {
        console.warn(JSON.stringify({
          errorCode: error instanceof Error && "code" in error ? error.code : error instanceof Error ? error.name : typeof error,
          event: "slack_phrase_match_failed",
        }));
        return false;
      }
    });
  } finally {
    matchContext.phrase = "";
    matchContext.text = "";
  }
}
