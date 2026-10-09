import { createContext, Script } from "node:vm";
import { slackPhraseFlags } from "./slack-phrases.js";

// Members write these expressions, and one that backtracks without end would
// hold the event loop for every organization. The VM stops matching that runs
// past the timeout, which covers all of a trigger's phrases together.
const matchTimeoutMs = 50;
const matchContext = createContext({ flags: slackPhraseFlags, phrases: [] as readonly string[], text: "" });
const matchScript = new Script("phrases.some((phrase) => new RegExp(phrase, flags).test(text))");

// Whether the text matches any of the phrases. When matching fails to compile
// or runs past the timeout, the text does not match.
export function matchesSlackPhrase(phrases: readonly string[], text: string): boolean {
  if (phrases.length === 0) return false;
  matchContext.phrases = phrases;
  matchContext.text = text;
  try {
    return matchScript.runInContext(matchContext, { timeout: matchTimeoutMs }) === true;
  } catch (error) {
    console.warn(JSON.stringify({
      errorCode: error instanceof Error && "code" in error ? error.code : error instanceof Error ? error.name : typeof error,
      event: "slack_phrase_match_failed",
    }));
    return false;
  } finally {
    matchContext.phrases = [];
    matchContext.text = "";
  }
}
