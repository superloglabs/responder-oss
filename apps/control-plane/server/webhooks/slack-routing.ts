// Who may ask tag mode, and which workspace answers, when a Slack team is
// connected to Superlog.

export type SlackAuthorProfile = {
  // The Slack team of the person who wrote the message.
  user_team?: string;
  user_profile?: {
    team?: string;
    is_restricted?: boolean;
    is_ultra_restricted?: boolean;
  };
};

// Why a person's message is not from a full member of the Slack team the event
// was delivered for, or null when it is. Tag mode answers members only: a
// person from another Slack team in a shared channel and a guest are not.
// Within an Enterprise Grid org, a member of another workspace in a channel
// that is not shared outside the org counts as a member. When Slack sends no
// team for the author, the message is taken as a member's.
export function slackOutsideAuthorReason(input: {
  // The Enterprise Grid org the event was delivered through, if any.
  enterpriseId?: string;
  event: SlackAuthorProfile;
  // The envelope's is_ext_shared_channel.
  externallyShared?: boolean;
  teamId: string;
}): "guest" | "other_team" | null {
  const profile = input.event.user_profile;
  if (profile?.is_restricted === true || profile?.is_ultra_restricted === true) {
    return "guest";
  }
  const authorTeam = input.event.user_team ?? profile?.team;
  if (!authorTeam || authorTeam === input.teamId) return null;
  if (input.enterpriseId && input.externallyShared === false) return null;
  return "other_team";
}

// The organizations that may answer a mention or direct message when more
// than one holds the Slack team. In a channel, that is every organization
// whose tag mode or automation chose the channel. Otherwise it is the one
// that connected the team first, so a later connection never takes over.
// Returns null when one organization or none holds the team, which leaves
// routing as it is.
export function slackConversationOrganizations(input: {
  // The organizations that chose the channel. Empty for a direct message.
  channelOrganizationIds: Iterable<string>;
  // The team's connections, oldest first.
  connections: ReadonlyArray<{ organizationId: string }>;
}): Set<string> | null {
  const organizations = new Set(
    input.connections.map((connection) => connection.organizationId),
  );
  if (organizations.size < 2) return null;
  const chosen = new Set(
    [...input.channelOrganizationIds].filter((id) => organizations.has(id)),
  );
  if (chosen.size > 0) return chosen;
  return new Set([input.connections[0]!.organizationId]);
}
