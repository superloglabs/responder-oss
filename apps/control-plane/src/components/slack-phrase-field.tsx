import { useId, useState } from "react";
import { slackPhrasesError, slackPhrasesFromText } from "../automation-configuration";

// Edits the phrases a Slack trigger ignores, one regular expression per line.
// The text is kept as typed and sent when the field loses focus, as the
// automation saves each change. Phrases set from outside, such as the saved
// ones a failed save restores, replace the text.
export function SlackPhraseField({ autoFocus = false, phrases, onChange }: {
  autoFocus?: boolean;
  phrases: string[];
  onChange: (phrases: string[] | undefined) => void;
}) {
  const inputId = useId();
  const hintId = useId();
  const [text, setText] = useState(() => phrases.join("\n"));
  const [shown, setShown] = useState(phrases);
  if (shown.join("\n") !== phrases.join("\n")) {
    setShown(phrases);
    setText(phrases.join("\n"));
  }
  const error = slackPhrasesError(slackPhrasesFromText(text));
  return <div className="automationTrigger__scheduleField automationTrigger__scheduleField--phrases">
    <label className="automationTrigger__fieldLabel" htmlFor={inputId}>Ignore messages matching</label>
    <textarea aria-describedby={hintId} aria-invalid={error !== null} autoCapitalize="off" autoComplete="off" autoFocus={autoFocus} className="automationTrigger__input automationTrigger__input--phrases" id={inputId} onBlur={() => {
      const next = slackPhrasesFromText(text);
      if ((next ?? []).join("\n") !== phrases.join("\n")) onChange(next);
    }} onChange={(event) => setText(event.target.value)} placeholder={"^Resolved:\ndeploy (started|finished)"} rows={3} spellCheck={false} value={text} />
    <span aria-live="polite" className={error ? "automationTrigger__hint automationTrigger__hint--error" : "automationTrigger__hint"} id={hintId}>{error ?? "One regular expression per line, case-insensitive. Matching messages do not start or continue a run."}</span>
  </div>;
}
