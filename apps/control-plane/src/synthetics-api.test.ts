import { describe, expect, it } from "vitest";
import {
  emptySyntheticForm,
  formatUptime,
  spanLabel,
  syntheticForm,
  syntheticRequestBody,
  timingChart,
  uptimeSegments,
  type SyntheticCheck,
} from "./synthetics-api";

describe("syntheticRequestBody", () => {
  it("asks for a name and URL first", () => {
    expect(syntheticRequestBody(emptySyntheticForm())).toEqual({ error: "Name the check." });
    expect(syntheticRequestBody({ ...emptySyntheticForm(), name: "Health" })).toEqual({ error: "Enter the URL to request." });
  });

  it("keeps saved secrets left blank, and drops the body of a GET", () => {
    const form = {
      ...emptySyntheticForm(),
      body: "{}",
      headers: [
        { name: "Authorization", saved: true, secret: true, value: "" },
        { name: " X-New ", saved: false, secret: true, value: "abc" },
        { name: "", saved: false, secret: false, value: "" },
      ],
      name: " Health ",
      slack: "account-1:C1",
      url: " https://api.example.com/health ",
    };
    const request = syntheticRequestBody(form);
    expect(request).toMatchObject({
      body: {
        body: null,
        headers: [
          { name: "Authorization", secret: true, value: null },
          { name: "X-New", secret: true, value: "abc" },
        ],
        name: "Health",
        slack: { channelId: "C1", integrationAccountId: "account-1" },
        url: "https://api.example.com/health",
      },
    });
    expect(syntheticRequestBody({ ...form, method: "POST" })).toMatchObject({ body: { body: "{}" } });
  });

  it("sends keys only for headers and JSON paths, and no value for exists", () => {
    const request = syntheticRequestBody({
      ...emptySyntheticForm(),
      assertions: [
        { key: "ignored", kind: "status_code", op: "eq", severity: "critical", value: " 200 " },
        { key: " $.ok ", kind: "json_path", op: "exists", severity: "degraded", value: "stale" },
      ],
      name: "Health",
      url: "https://example.com",
    });
    expect("body" in request && request.body.assertions).toEqual([
      { kind: "status_code", op: "eq", severity: "critical", value: "200" },
      { key: "$.ok", kind: "json_path", op: "exists", severity: "degraded", value: "" },
    ]);
  });

  it("reads a saved check back into the form", () => {
    const check = {
      assertions: [{ kind: "body", op: "contains", severity: "critical", value: "ok" }],
      body: null,
      headers: [{ name: "Authorization", secret: true, value: "" }],
      slack: { channelId: "C1", integrationAccountId: "account-1" },
    } as unknown as SyntheticCheck;
    expect(syntheticForm(check)).toMatchObject({
      assertions: [{ key: "", kind: "body" }],
      body: "",
      headers: [{ saved: true, secret: true }],
      slack: "account-1:C1",
    });
  });
});

describe("uptime display", () => {
  it("fills every bucket of the range and colours each by its worst run", () => {
    const since = "2026-10-15T00:00:00.000Z";
    const buckets = [
      { averageMs: null, bucket: "2026-10-15T00:15:00.000Z", degraded: 0, failed: 1, passed: 3 },
      {
        averageMs: { connectMs: 1, dnsMs: 2, downloadMs: 3, firstByteMs: 4, tlsMs: 5, totalMs: 15 },
        bucket: "2026-10-15T00:30:00.000Z",
        degraded: 1,
        failed: 0,
        passed: 2,
      },
    ];
    const segments = uptimeSegments(buckets, since, 900, Date.parse("2026-10-15T01:00:00.000Z"));

    expect(segments.map((segment) => segment.status)).toEqual(["none", "failed", "degraded", "none"]);
    const chart = timingChart(segments, buckets, 900);
    expect(chart.series.map((series) => series.name)).toEqual(["DNS", "Connect", "TLS", "First byte", "Download"]);
    expect(chart.series[0]!.values).toEqual([null, null, 2, null]);
  });

  it("never rounds a failure up to full uptime", () => {
    expect(formatUptime(1)).toBe("100%");
    expect(formatUptime(0.99999)).toBe("99.99%");
    expect(formatUptime(0.5)).toBe("50%");
    expect(formatUptime(null)).toBe("—");
  });

  it("describes spans of time", () => {
    expect(spanLabel(30_000)).toBe("1 minute");
    expect(spanLabel(90 * 60_000)).toBe("1 hour 30 min");
    expect(spanLabel(26 * 3_600_000)).toBe("1 day 2 hours");
  });
});
