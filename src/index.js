export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return jsonResponse(
        {
          ok: false,
          error: "Method not allowed"
        },
        405
      );
    }

    const incomingWorkerKey = (request.headers.get("Worker-Key") || "").trim();
    const pagerDutyRoutingKey = request.headers.get("PagerDuty-Routing-Key");
    const VALID_SEVERITIES = ["critical", "error", "warning", "info"];
    const rawSeverity = (request.headers.get("PagerDuty-Severity") || "").toLowerCase();
    const requestedSeverity = VALID_SEVERITIES.includes(rawSeverity) ? rawSeverity : "critical";

    // Authentication check using the WORKER_KEY secret.
    // Both values are trimmed so a stray newline/space (common when piping a
    // file into `wrangler secret put`) doesn't cause a confusing 401.
    // Uses a constant-time comparison to avoid leaking the key via timing.
    const workerKey = (env.WORKER_KEY || "").trim();

    // Server misconfiguration: the WORKER_KEY secret is not set on the worker.
    // Reported separately (500) so it isn't confused with a bad/missing request key.
    if (!workerKey) {
      return jsonResponse(
        {
          ok: false,
          error: "Server misconfigured: WORKER_KEY secret is not set"
        },
        500
      );
    }

    // Client did not send the Worker-Key header.
    if (!incomingWorkerKey) {
      return jsonResponse(
        {
          ok: false,
          error: "Missing Worker-Key header"
        },
        401
      );
    }

    // Header present but does not match the configured secret.
    if (!(await timingSafeEqualString(incomingWorkerKey, workerKey))) {
      return jsonResponse(
        {
          ok: false,
          error: "Unauthorized"
        },
        401
      );
    }

    // PagerDuty routing key must be supplied by caller
    if (!pagerDutyRoutingKey) {
      return jsonResponse(
        {
          ok: false,
          error: "Missing PagerDuty-Routing-Key header"
        },
        400
      );
    }

    let bodyText;

    try {
      bodyText = await request.text();
    } catch {
      return jsonResponse(
        {
          ok: false,
          error: "Could not read request body"
        },
        400
      );
    }

    let unifiData;

    try {
      unifiData = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      unifiData = {
        raw: bodyText
      };
    }

    const alarmId = unifiData?.alarm_id || "UNKNOWN";

    const isTest = alarmId === "TEST";

    const alarmName = unifiData?.alarm?.name || alarmId;

    const timestampRaw =
      unifiData?.timestamp ||
      unifiData?.alarm?.timestamp ||
      Date.now();

    const timestamp = normalizeTimestamp(timestampRaw);

    const trigger = unifiData?.alarm?.triggers?.[0] || {};
    const device = trigger?.device || "unknown-device";
    const triggerKey = trigger?.key || "unknown-trigger";
    const eventId = trigger?.eventId || null;

    const conditions = unifiData?.alarm?.conditions || [];
    const sources = unifiData?.alarm?.sources || [];

    const pdPayload = {
      routing_key: pagerDutyRoutingKey,
      event_action: "trigger",

      // TEST creates a fresh event each time; production alarms dedupe by alarm + device.
      dedup_key: isTest
        ? `unifi-test-${Date.now()}`
        : `unifi-${alarmId}-${device}`,

      payload: {
        summary: isTest
          ? "TEST ALERT from UniFi Protect"
          : `UniFi Protect Alarm: ${alarmName} on ${device}`,

        severity: isTest ? "info" : requestedSeverity,
        source: "unifi-protect",
        timestamp: timestamp,

        component: device,
        group: "unifi-protect",
        class: alarmId,

        custom_details: {
          alarm_id: alarmId,
          alarm_name: alarmName,
          device: device,
          trigger: triggerKey,
          event_id: eventId,
          sources: sources,
          conditions: conditions,
          unifi_timestamp: timestampRaw,
          is_test: isTest,
          raw_unifi_payload: unifiData
        }
      }
    };

    const pagerdutyEventsUrl =
      env.PAGERDUTY_EVENTS_URL || "https://events.pagerduty.com/v2/enqueue";

    let pdResponse;

    try {
      pdResponse = await fetch(pagerdutyEventsUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(pdPayload)
      });
    } catch (err) {
      return jsonResponse(
        {
          ok: false,
          sent: false,
          error: "Failed to reach PagerDuty",
          detail: err?.message || String(err),
          alarm_id: alarmId,
          dedup_key: pdPayload.dedup_key
        },
        502
      );
    }

    let pdResponseText;

    try {
      pdResponseText = await pdResponse.text();
    } catch {
      pdResponseText = undefined;
    }

    return jsonResponse(
      {
        ok: pdResponse.ok,
        sent: pdResponse.ok,
        pagerduty_status: pdResponse.status,
        pagerduty_response: safeJsonOrText(pdResponseText),
        alarm_id: alarmId,
        dedup_key: pdPayload.dedup_key
      },
      pdResponse.ok ? 200 : 502
    );
  }
};

function normalizeTimestamp(value) {
  // UniFi timestamps are often epoch milliseconds.
  if (typeof value === "number") {
    return safeIsoString(new Date(value));
  }

  // Numeric string epoch milliseconds.
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return safeIsoString(new Date(Number(value)));
  }

  // ISO-ish string.
  return safeIsoString(new Date(value));
}

function safeIsoString(date) {
  // An out-of-range or unparseable date would make toISOString() throw,
  // so validate before formatting and fall back to "now".
  if (date instanceof Date && !Number.isNaN(date.getTime())) {
    return date.toISOString();
  }

  return new Date().toISOString();
}

async function timingSafeEqualString(a, b) {
  const encoder = new TextEncoder();
  const [aDigest, bDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b))
  ]);

  // Compare fixed-length (32-byte) digests in constant time. Hashing first
  // means the comparison never short-circuits on the raw key length.
  const aBytes = new Uint8Array(aDigest);
  const bBytes = new Uint8Array(bDigest);

  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i] ^ bBytes[i];
  }

  return diff === 0;
}

function safeJsonOrText(text) {
  if (!text) {
    return "";
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function jsonResponse(data, status = 200) {
  const headers = {
    "Content-Type": "application/json"
  };

  // Surface the error message in a header to make troubleshooting easier
  // when the response body isn't readily visible (e.g. in proxy/edge logs).
  if (data && data.error) {
    headers["X-Worker-Error"] = String(data.error).replace(/[\r\n]+/g, " ");
  }

  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers
  });
}
