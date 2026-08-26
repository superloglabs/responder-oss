# Product analytics

Responder captures browser activity and a small, explicit server-side PostHog
event taxonomy when PostHog is explicitly configured. The browser SDK runs in
the authenticated app. It captures initial and client-side navigation `$pageview`
events without URL query strings or fragments, plus session recordings. All
form input values are masked in recordings.
Every browser and server event includes `project: "responder"` so Responder
activity can be separated from other products sharing the PostHog project.

| Event | Captured when | Notable properties |
| --- | --- | --- |
| `user signed up` | Email or social signup succeeds | `signup_method` |
| `organization created` | A workspace is created | `organization_id`, `organization_name`, `organization_slug` |
| `integration connected` | An OAuth callback finishes and resources are synced | `provider`, `integration_account_id`, `resource_count` |
| `agent created` | A new agent and its initial configuration are persisted | `agent_id`, `trigger_kind`, `model`, `enabled`, `pr_mode` |
| `prompt copied` | A user clicks **Copy prompt** in Slack | `issue_id`, `issue_found`, `team_id`, `channel_id`, `surface` |
| `investigation created` | A new investigation or replay is persisted and accepted for processing | `investigation_id`, `agent_id`, `provider`, `is_replay`, `source_investigation_id` |
| `investigation feedback submitted` | A Slack user rates a completed investigation response | `investigation_id`, `agent_id`, `feedback`, `organization_id`, `organization_name`, `slack_user_id`, `user_name`, `team_id`, `channel_id`, `surface` |
| `investigation rerun` | A finished investigation is accepted for another run with the active Agent configuration | `investigation_id`, `agent_id`, `agent_config_version_id`, `provider` |

Events associated with a workspace include `organization_id` and the PostHog
`organization` group. Authenticated events use the Better Auth user ID as their
distinct ID. Machine-triggered investigations and Slack actions do not create
PostHog person profiles.
Slack feedback includes the user name supplied in the interaction payload when
Slack provides one.

Configure these variables in the control-plane project:

```dotenv
POSTHOG_PROJECT_TOKEN=
POSTHOG_HOST=https://eu.i.posthog.com
VITE_POSTHOG_PROJECT_TOKEN=
VITE_POSTHOG_HOST=https://eu.i.posthog.com
```

Configure `POSTHOG_PROJECT_TOKEN` and `POSTHOG_HOST` in the agent project as
well. Analytics is disabled in each process when its project token is empty.
Responder defaults to the PostHog EU Cloud ingestion host when `POSTHOG_HOST`
or `VITE_POSTHOG_HOST` is not set. The browser identifies signed-in
users with their Better Auth user ID and attaches their active workspace as the
PostHog `organization` group. Signing out resets the browser identity. Session
Replay must also be enabled in the PostHog project; once enabled, the browser
requests recording for every session while masking all input values.

## X Ads conversion tracking

Signups are reported to X Ads through two channels that deduplicate against
each other with the Better Auth user ID as the `conversion_id` key:

- **Browser pixel** (`uwt.js`), which works without any Ads API approval. The
  web app loads the tag at startup and fires the signup event after email
  signup succeeds, or on the first-time social login landing marked by the
  `signed_up=1` callback parameter. Content blockers can suppress it.
- **Server-side [Conversion API](https://docs.x.com/x-ads-api/measurement/web-conversions)**,
  called from the `user.create` hook alongside the `user signed up` PostHog
  event. It is out of reach of content blockers but requires Ads API
  ("Conversion Only" tier) approval for the developer app that issued the
  OAuth credentials. X matches the conversion through the SHA-256 hash of the
  account email plus the `twclid` click id when the visitor arrived through an
  ad; the web app stores `twclid` from the landing URL in the first-party
  `responder_twclid` cookie for 30 days, and the signup request carries it to
  the server. Delivery failures are logged and never fail the signup.

Configure these variables in the control-plane project for the server-side
path. The OAuth 1.0a credentials come from a developer app attached to the X
Ads account, and the event id is the full identifier from X Events Manager.
The Conversion API path is disabled when any of them are unset.

```dotenv
X_ADS_CONSUMER_KEY=
X_ADS_CONSUMER_SECRET=
X_ADS_ACCESS_TOKEN=
X_ADS_ACCESS_TOKEN_SECRET=
X_ADS_SIGNUP_EVENT_ID=tw-pixel1-event1
VITE_X_ADS_SIGNUP_EVENT_ID=tw-pixel1-event1
```

The browser pixel is disabled unless `VITE_X_ADS_SIGNUP_EVENT_ID` is set during
the web build.
