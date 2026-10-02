import { useEffect, useState } from "react";
import { fetchSentryEnvironments } from "../automations-api";
import { excludedSentryEnvironments, sentryEnvironmentChoices } from "../automation-configuration";
import { AutomationResourcePicker } from "./automation-resource-picker";

// Chooses which Sentry environments start runs. Every environment is checked
// until the member unchecks it.
export function SentryEnvironmentPicker({ accountId, excluded, onChange }: {
  accountId: string;
  excluded: string[];
  onChange: (excluded: string[] | undefined) => void;
}) {
  const [environments, setEnvironments] = useState<string[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    fetchSentryEnvironments(accountId, controller.signal).then(setEnvironments, () => undefined);
    return () => controller.abort();
  }, [accountId]);
  const choices = sentryEnvironmentChoices(environments, excluded);
  const checked = choices.filter((environment) => !excluded.includes(environment));
  return <AutomationResourcePicker
    label="Environment"
    resources={choices.map((environment) => ({ displayName: environment, externalId: environment }))}
    selected={checked}
    summary={excluded.length === 0 ? "All environments" : checked.length === 0 ? "No environments" : undefined}
    onChange={(ids) => onChange(excludedSentryEnvironments(choices, ids))}
    onRefresh={async () => setEnvironments(await fetchSentryEnvironments(accountId))}
  />;
}
