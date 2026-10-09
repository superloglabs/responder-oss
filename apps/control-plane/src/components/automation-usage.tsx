import { useCallback, useState } from "react";
import { fetchAutomationUsage } from "../automations-api";
import type { UsageHistoryDays } from "../usage-history-presentation";
import { useUsageHistory } from "../use-usage-history";
import { UsageMetricCard, UsageRangeControl } from "./usage-history-view";
import "./usage-history.css";

export function AutomationUsage({ automationId }: { automationId: string }) {
  const [days, setDays] = useState<UsageHistoryDays>(30);
  const load = useCallback((range: UsageHistoryDays) => fetchAutomationUsage(automationId, range), [automationId]);
  const { error, history, loading } = useUsageHistory(load, days);
  return (
    <div className="usageHistory" aria-busy={loading}>
      <div className="usageHistory__toolbar">
        <p>Charged usage of this automation&apos;s runs, by day in UTC.</p>
        <UsageRangeControl onChange={setDays} value={days} />
      </div>
      {error ? <p className="formError" role="alert">{error}</p> : null}
      {history ? (
        <div className="usageHistory__cards">
          <UsageMetricCard
            history={history}
            metric="machineHours"
            note="Time the run sandboxes were up."
          />
          <UsageMetricCard
            history={history}
            metric="aiCharge"
            note="Superlog model usage. Runs with your own API key or ChatGPT subscription are not charged here."
          />
        </div>
      ) : !error ? <p className="usageHistory__loading">Loading usage…</p> : null}
    </div>
  );
}
