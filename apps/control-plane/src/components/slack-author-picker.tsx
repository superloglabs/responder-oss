import { useEffect, useRef, useState } from "react";
import { fetchSlackAuthors, type SlackAuthor } from "../automations-api";
import { AutomationResourcePicker } from "./automation-resource-picker";

type ListedAuthor = SlackAuthor & { kind: "app" | "person" };

// Chooses the only people and apps whose messages start a Slack trigger's
// runs, and the ones it ignores. Both lists offer whoever posted in the
// selected channels since they were watched, loaded once for both.
export function SlackAuthorPickers({ accountId, channelIds, ignored, included, onIgnoredChange, onIncludedChange }: {
  accountId: string;
  channelIds: string[];
  ignored: SlackAuthor[];
  included: SlackAuthor[];
  onIgnoredChange: (ignored: SlackAuthor[] | undefined) => void;
  onIncludedChange: (included: SlackAuthor[] | undefined) => void;
}) {
  // Each list is kept with the selection it was loaded for, so a response
  // for channels that are no longer selected is never shown.
  const selection = `${accountId}:${channelIds.join(",")}`;
  const current = useRef(selection);
  const [loaded, setLoaded] = useState<{ authors: ListedAuthor[]; selection: string } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    current.current = selection;
    const controller = new AbortController();
    fetchSlackAuthors(accountId, channelIds, controller.signal).then(
      (authors) => setLoaded({ authors, selection }),
      () => { if (!controller.signal.aborted) setFailed(selection); },
    );
    return () => controller.abort();
    // channelIds is a new array on each render; the selection key covers it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection]);
  const authors = loaded?.selection === selection ? loaded.authors : [];
  const empty = loaded?.selection === selection
    ? "No one has posted in these channels since they were added."
    : failed === selection
      ? "Could not load authors. Refresh to try again."
      : "Loading authors…";
  async function refresh() {
    const requested = selection;
    const next = await fetchSlackAuthors(accountId, channelIds);
    if (current.current === requested) setLoaded({ authors: next, selection: requested });
  }
  function picker(title: string, none: string, selected: SlackAuthor[], onChange: (selected: SlackAuthor[] | undefined) => void) {
    const choices: Array<SlackAuthor | ListedAuthor> = [
      ...selected.filter((author) => !authors.some((item) => item.id === author.id)),
      ...authors,
    ];
    return <AutomationResourcePicker
      empty={empty}
      label="Author"
      resources={choices.map((author) => ({
        displayName: "kind" in author && author.kind === "app" ? `${author.name} (app)` : author.name,
        externalId: author.id,
      }))}
      selected={selected.map((author) => author.id)}
      summary={selected.length === 0 ? none : undefined}
      title={title}
      onChange={(ids) => {
        const next = choices.filter((author) => ids.includes(author.id)).map(({ id, name }) => ({ id, name }));
        onChange(next.length ? next : undefined);
      }}
      onRefresh={refresh}
    />;
  }
  return <>
    {picker("Only messages from", "Everyone", included, onIncludedChange)}
    {picker("Ignore messages from", "No one", ignored, onIgnoredChange)}
  </>;
}
