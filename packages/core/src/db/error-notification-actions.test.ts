import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { getDatabase } from "./client.js";
import { getErrorNotificationForSlackAction } from "./error-notifications.js";
vi.mock("./client.js", () => ({ getDatabase: vi.fn() }));
describe("Slack error action tenancy", () => {
  it("matches the delivery, channel, team and connected account in the same organization", async () => {
    const row = { organizationId: "org", issueId: "issue" };
    const limit = vi.fn().mockResolvedValue([row]);
    const where = vi.fn().mockReturnValue({ limit });
    const innerJoin = vi.fn().mockReturnValue({ where });
    vi.mocked(getDatabase).mockReturnValue({ select: () => ({ from: () => ({ innerJoin }) }) } as never);
    expect(await getErrorNotificationForSlackAction({ deliveryId: "delivery", teamId: "T123", channelId: "C123" })).toEqual(row);
    const dialect = new PgDialect();
    const join = dialect.sqlToQuery(innerJoin.mock.calls[0]![1]);
    expect(join.sql).toContain('"integration_accounts"."id"::text = "error_notification_deliveries"."target"->>\'integrationAccountId\'');
    expect(join.sql).toContain('"integration_accounts"."organization_id" = "error_notification_deliveries"."organization_id"');
    const filter = dialect.sqlToQuery(where.mock.calls[0]![0]);
    expect(filter.sql).toContain('"integration_accounts"."external_account_id" =');
    expect(filter.sql).toContain("->>'channelId' =");
    expect(filter.params).toEqual(["delivery", "sent", "slack", "connected", "T123", "C123"]);
    limit.mockResolvedValue([]);
    expect(await getErrorNotificationForSlackAction({ deliveryId: "delivery", teamId: "other", channelId: "other" })).toBeNull();
  });
});
