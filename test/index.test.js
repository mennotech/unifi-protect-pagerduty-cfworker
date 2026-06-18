import { describe, it, expect, vi, beforeEach } from "vitest";
import worker from "../src/index.js";

const ENV = {
  WORKER_KEY: "test-secret",
  PAGERDUTY_EVENTS_URL: "https://events.pagerduty.com/v2/enqueue"
};

const VALID_HEADERS = {
  "Worker-Key": "test-secret",
  "PagerDuty-Routing-Key": "pd-routing-key",
  "Content-Type": "application/json"
};

const LIVE_PAYLOAD = {
  alarm: {
    name: "Away - Motion Webhook",
    sources: [{ device: "8C3066AA3F4E", type: "include" }],
    conditions: [{ condition: { type: "is", source: "sensor_motion" } }],
    triggers: [
      {
        key: "sensor_motion",
        device: "8C3066AA3F4E",
        eventId: "6a34137603591903e404ef5e",
        timestamp: 1781797750858
      }
    ]
  },
  timestamp: 1781797750931,
  alarm_id: "019edb38-63c3-7403-8be2-dd9216e11227"
};

const TEST_PAYLOAD = {
  alarm: {
    name: "Away - Motion Webhook",
    sources: [{ device: "8C3066AA3F4E", type: "include" }],
    conditions: [{ condition: { type: "is", source: "sensor_motion" } }],
    triggers: [
      {
        key: "sensor_motion",
        device: "FAKE_MAC",
        eventId: "testEventId",
        timestamp: 1781797726904
      }
    ]
  },
  timestamp: 1781797726940,
  alarm_id: "TEST"
};

function makeRequest(body, headers = VALID_HEADERS, method = "POST") {
  return new Request("https://worker.example.com/", {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined
  });
}

function mockPagerDuty(status = 202, responseBody = { status: "success", message: "Event processed", dedup_key: "test-dedup" }) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(responseBody), {
        status,
        headers: { "Content-Type": "application/json" }
      })
    )
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("method guard", () => {
  it("returns 405 for GET requests", async () => {
    const req = makeRequest(null, VALID_HEADERS, "GET");
    const res = await worker.fetch(req, ENV);
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.error).toBe("Method not allowed");
  });
});

describe("authentication", () => {
  it("returns 401 when Worker-Key is missing", async () => {
    const { "Worker-Key": _omit, ...headers } = VALID_HEADERS;
    const req = makeRequest(LIVE_PAYLOAD, headers);
    const res = await worker.fetch(req, ENV);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 401 when Worker-Key is wrong", async () => {
    const req = makeRequest(LIVE_PAYLOAD, { ...VALID_HEADERS, "Worker-Key": "wrong-key" });
    const res = await worker.fetch(req, ENV);
    expect(res.status).toBe(401);
  });
});

describe("routing key", () => {
  it("returns 400 when PagerDuty-Routing-Key is missing", async () => {
    const { "PagerDuty-Routing-Key": _omit, ...headers } = VALID_HEADERS;
    const req = makeRequest(LIVE_PAYLOAD, headers);
    const res = await worker.fetch(req, ENV);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Missing PagerDuty-Routing-Key header");
  });
});

describe("live alarm", () => {
  it("forwards payload to PagerDuty and returns 200", async () => {
    mockPagerDuty(202);
    const req = makeRequest(LIVE_PAYLOAD);
    const res = await worker.fetch(req, ENV);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.alarm_id).toBe(LIVE_PAYLOAD.alarm_id);
  });

  it("sets dedup_key based on alarm_id and device", async () => {
    mockPagerDuty(202);
    const req = makeRequest(LIVE_PAYLOAD);
    const res = await worker.fetch(req, ENV);
    const body = await res.json();
    expect(body.dedup_key).toBe(`unifi-${LIVE_PAYLOAD.alarm_id}-8C3066AA3F4E`);
  });

  it("sends correct payload structure to PagerDuty", async () => {
    mockPagerDuty(202);
    const req = makeRequest(LIVE_PAYLOAD);
    await worker.fetch(req, ENV);

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(ENV.PAGERDUTY_EVENTS_URL);
    const sent = JSON.parse(init.body);
    expect(sent.event_action).toBe("trigger");
    expect(sent.routing_key).toBe("pd-routing-key");
    expect(sent.payload.summary).toContain("Away - Motion Webhook");
    expect(sent.payload.severity).toBe("critical");
    expect(sent.payload.custom_details.event_id).toBe("6a34137603591903e404ef5e");
    expect(sent.payload.custom_details.is_test).toBe(false);
  });

  it("returns 502 when PagerDuty returns an error", async () => {
    mockPagerDuty(400, { status: "invalid event" });
    const req = makeRequest(LIVE_PAYLOAD);
    const res = await worker.fetch(req, ENV);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });
});

describe("TEST alarm", () => {
  it("uses info severity regardless of PagerDuty-Severity header", async () => {
    mockPagerDuty(202);
    const req = makeRequest(TEST_PAYLOAD, { ...VALID_HEADERS, "PagerDuty-Severity": "critical" });
    await worker.fetch(req, ENV);
    const [, init] = fetch.mock.calls[0];
    const sent = JSON.parse(init.body);
    expect(sent.payload.severity).toBe("info");
  });

  it("uses a unique dedup_key each time", async () => {
    mockPagerDuty(202);
    vi.useFakeTimers();

    vi.setSystemTime(1000);
    const res1 = await worker.fetch(makeRequest(TEST_PAYLOAD), ENV);
    const body1 = await res1.json();

    vi.setSystemTime(2000);
    const res2 = await worker.fetch(makeRequest(TEST_PAYLOAD), ENV);
    const body2 = await res2.json();

    vi.useRealTimers();

    expect(body1.dedup_key).toMatch(/^unifi-test-/);
    expect(body1.dedup_key).not.toBe(body2.dedup_key);
  });

  it("sets summary to TEST ALERT", async () => {
    mockPagerDuty(202);
    const req = makeRequest(TEST_PAYLOAD);
    await worker.fetch(req, ENV);
    const [, init] = fetch.mock.calls[0];
    const sent = JSON.parse(init.body);
    expect(sent.payload.summary).toBe("TEST ALERT from UniFi Protect");
  });
});

describe("PagerDuty-Severity header", () => {
  it.each(["critical", "error", "warning", "info"])(
    "accepts valid severity: %s",
    async (severity) => {
      mockPagerDuty(202);
      const req = makeRequest(LIVE_PAYLOAD, { ...VALID_HEADERS, "PagerDuty-Severity": severity });
      await worker.fetch(req, ENV);
      const [, init] = fetch.mock.calls[0];
      const sent = JSON.parse(init.body);
      expect(sent.payload.severity).toBe(severity);
    }
  );

  it("defaults to critical for invalid severity", async () => {
    mockPagerDuty(202);
    const req = makeRequest(LIVE_PAYLOAD, { ...VALID_HEADERS, "PagerDuty-Severity": "urgent" });
    await worker.fetch(req, ENV);
    const [, init] = fetch.mock.calls[0];
    const sent = JSON.parse(init.body);
    expect(sent.payload.severity).toBe("critical");
  });

  it("defaults to critical when header is absent", async () => {
    mockPagerDuty(202);
    const req = makeRequest(LIVE_PAYLOAD);
    await worker.fetch(req, ENV);
    const [, init] = fetch.mock.calls[0];
    const sent = JSON.parse(init.body);
    expect(sent.payload.severity).toBe("critical");
  });

  it("is case-insensitive", async () => {
    mockPagerDuty(202);
    const req = makeRequest(LIVE_PAYLOAD, { ...VALID_HEADERS, "PagerDuty-Severity": "WARNING" });
    await worker.fetch(req, ENV);
    const [, init] = fetch.mock.calls[0];
    const sent = JSON.parse(init.body);
    expect(sent.payload.severity).toBe("warning");
  });
});

describe("malformed body", () => {
  it("still processes a non-JSON body without crashing", async () => {
    mockPagerDuty(202);
    const req = new Request("https://worker.example.com/", {
      method: "POST",
      headers: VALID_HEADERS,
      body: "not-json"
    });
    const res = await worker.fetch(req, ENV);
    expect(res.status).toBe(200);
  });
});
