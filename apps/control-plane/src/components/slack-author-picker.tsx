import { useEffect, useState } from "react";
import { fetchSlackAuthors, type SlackAuthor } from "../automations-api";
import { AutomationResourcePicker } from "./automation-resource-picker";

// Chooses the people and apps whose messages a Slack trigger ignores. It
// offers whoever posted in the selected channels since they were watched.
export function SlackAuthorPicker({ accountId, channelIds, ignored, onChange }: {
  accountId: string;
  channelIds: string[];
  ignored: SlackAuthor[];
  onChange: (ignored: SlackAuthor[] | undefined) => void;
}) {
  const [authors, setAuthors] = useState<Array<SlackAuthor & { kind: "app" | "person" }>>([]);
  const channels = channelIds.join(",");
  useEffect(() => {
    const controller = new AbortController();
    fetchSlackAuthors(accountId, channels.split(","), controller.signal).then(setAuthors, () => undefined);
    return () => controller.abort();
  }, [accountId, channels]);
  const choices = [
    ...ignored.filter((author) => !authors.some((item) => item.id === author.id)),
    ...authors,
  ];
  return <AutomationResourcePicker
    empty="No one has posted in these channels since they were added."
    label="Author"
    resources={choices.map((author) => ({
      displayName: "kind" in author && author.kind === "app" ? `${author.name} (app)` : author.name,
      externalId: author.id,
    }))}
    selected={ignored.map((author) => author.id)}
    summary={ignored.length === 0 ? "No one" : undefined}
    title="Ignore messages from"
    onChange={(ids) => {
      const next = choices.filter((author) => ids.includes(author.id)).map(({ id, name }) => ({ id, name }));
      onChange(next.length ? next : undefined);
    }}
    onRefresh={async () => setAuthors(await fetchSlackAuthors(accountId, channels.split(",")))}
  />;
}
