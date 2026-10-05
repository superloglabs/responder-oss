import { useEffect, useRef, useState } from "react";
import { fetchSlackAuthors, type SlackAuthor } from "../automations-api";
import { AutomationResourcePicker } from "./automation-resource-picker";

type ListedAuthor = SlackAuthor & { kind: "app" | "person" };

// Chooses the people and apps whose messages a Slack trigger ignores. It
// offers whoever posted in the selected channels since they were watched,
// under the names Slack shows now rather than those saved with the trigger.
export function SlackAuthorPicker({ accountId, channelIds, ignored, onChange }: {
  accountId: string;
  channelIds: string[];
  ignored: SlackAuthor[];
  onChange: (ignored: SlackAuthor[] | undefined) => void;
}) {
  // Each list is kept with the selection it was loaded for, so a response
  // for channels that are no longer selected is never shown.
  const selection = `${accountId}:${channelIds.join(",")}`;
  const requestedSelection = useRef(selection);
  const [loaded, setLoaded] = useState<{ authors: ListedAuthor[]; namesNeedReconnect: boolean; selection: string } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    requestedSelection.current = selection;
    const controller = new AbortController();
    fetchSlackAuthors(accountId, channelIds, controller.signal).then(
      (list) => setLoaded({ ...list, selection }),
      () => { if (!controller.signal.aborted) setFailed(selection); },
    );
    return () => controller.abort();
    // channelIds is a new array on each render; the selection key covers it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection]);
  const current = loaded?.selection === selection ? loaded : null;
  const authors = current?.authors ?? [];
  const choices: Array<SlackAuthor | ListedAuthor> = [
    ...ignored.filter((author) => !authors.some((item) => item.id === author.id)),
    ...authors,
  ];
  return <AutomationResourcePicker
    empty={loaded?.selection === selection
      ? "No one has posted in these channels since they were added."
      : failed === selection
        ? "Could not load authors. Refresh to try again."
        : "Loading authors…"}
    label="Author"
    resources={choices.map((author) => ({
      displayName: "kind" in author && author.kind === "app" ? `${author.name} (app)` : author.name,
      externalId: author.id,
    }))}
    selected={ignored.map((author) => author.id)}
    summary={ignored.length === 0 ? "No one" : undefined}
    note={current?.namesNeedReconnect ? "Reconnect Slack in Settings to show names instead of IDs." : undefined}
    title="Ignore messages from"
    onChange={(ids) => {
      const next = choices.filter((author) => ids.includes(author.id)).map(({ id, name }) => ({ id, name }));
      onChange(next.length ? next : undefined);
    }}
    onRefresh={async () => {
      const requested = selection;
      const next = await fetchSlackAuthors(accountId, channelIds);
      if (requestedSelection.current === requested) setLoaded({ ...next, selection: requested });
    }}
  />;
}
