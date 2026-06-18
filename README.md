# unifi-protect-pagerduty-cfworker

A Cloudflare Worker that receives webhook events from [UniFi Protect](https://ui.com/camera-security) and forwards them to [PagerDuty](https://www.pagerduty.com/) as alerts.

## How it works

UniFi Protect sends a `POST` request to the worker with alarm data. The worker authenticates the request, transforms the payload into the PagerDuty Events v2 format, and enqueues an alert.

## Setup

### 1. Install dependencies

```sh
npm install
```

### 2. Configure secrets

The `WORKER_KEY` authenticates incoming requests from UniFi Protect. Treat it
like a password: anyone who has it can trigger PagerDuty alerts through this
worker. Store it **only** as an encrypted Cloudflare secret — never in
`wrangler.toml`, source code, or version control.

Set it with:

```sh
npx wrangler secret put WORKER_KEY
```

Wrangler prompts for the value and stores it encrypted in Cloudflare; it is not
written to disk and is not visible after creation (you can only overwrite or
delete it). It is exposed to the worker at runtime as `env.WORKER_KEY`.

Guidelines for handling the key safely:

- **Generate a strong, random value.** For example:
  ```sh
  openssl rand -base64 32
  ```
- **Never commit it.** Keep it out of `wrangler.toml` `[vars]`, code, and logs.
  `[vars]` values are stored in plaintext and bundled with the worker, so they
  are not appropriate for secrets.
- **Paste it at the prompt**, not as a shell argument, so it doesn't land in your
  shell history. If you must pipe it, do so from a secure source:
  ```sh
  cat key.txt | npx wrangler secret put WORKER_KEY
  ```
- **Use a different key per environment** (production vs. staging). With Wrangler
  environments, target one explicitly:
  ```sh
  npx wrangler secret put WORKER_KEY --env production
  ```
- **Rotate periodically** by running `wrangler secret put WORKER_KEY` again with a
  new value, then update the `Worker-Key` header in UniFi Protect. Update the
  worker first so both old and new requests fail closed during the swap.
- **Distribute it securely** to whoever configures the UniFi Protect webhook
  (e.g. a password manager), not over email or chat.
- **List/delete secrets** when auditing or decommissioning:
  ```sh
  npx wrangler secret list
  npx wrangler secret delete WORKER_KEY
  ```

The worker compares the supplied `Worker-Key` header against `WORKER_KEY` using a
constant-time comparison, so the secret is not leaked through response timing.

### 3. (Optional) Update `wrangler.toml`

The `PAGERDUTY_EVENTS_URL` var defaults to the EU endpoint. Change it if you use the US endpoint:

```toml
[vars]
PAGERDUTY_EVENTS_URL = "https://events.pagerduty.com/v2/enqueue"
```

> Only put non-sensitive configuration in `[vars]`. Secrets like `WORKER_KEY`
> must use `wrangler secret put` (see above).

### 4. Deploy

```sh
npm run deploy
```

## Local development

Create a `.dev.vars` file with your local secret values:

```
WORKER_KEY=your-secret-here
```

`.dev.vars` is already listed in `.gitignore` so it is never committed. Use a
throwaway local value here, not your production key.

Then run:


```sh
npm run dev
```

## Sending a request

Every request must include two headers:

| Header | Description |
|---|---|
| `Worker-Key` | Must match the `WORKER_KEY` secret configured on the worker |
| `PagerDuty-Routing-Key` | Your PagerDuty Events API v2 integration key |

Example `curl`:

```sh
curl -X POST https://<your-worker>.workers.dev \
  -H "Worker-Key: your-secret-here" \
  -H "PagerDuty-Routing-Key: your-pd-routing-key" \
  -H "Content-Type: application/json" \
  -d '{"alarm_id":"TEST"}'
```

Sending `alarm_id: "TEST"` creates a fresh info-severity event each time (no deduplication), useful for verifying the integration end-to-end.

## UniFi Protect payload

UniFi Protect sends a JSON body in this format.

Test event (`alarm_id: "TEST"`):

```json
{
  "alarm": {
    "name": "Away - Motion Webhook",
    "sources": [{"device": "8C3066AA3F4E", "type": "include"}],
    "conditions": [{"condition": {"type": "is", "source": "sensor_motion"}}],
    "triggers": [{
      "key": "sensor_motion",
      "device": "FAKE_MAC",
      "eventId": "testEventId",
      "timestamp": 1781797726904
    }]
  },
  "timestamp": 1781797726940,
  "alarm_id": "TEST"
}
```

Live event:

```json
{
  "alarm": {
    "name": "Away - Motion Webhook",
    "sources": [{"device": "8C3066AA3F4E", "type": "include"}],
    "conditions": [{"condition": {"type": "is", "source": "sensor_motion"}}],
    "triggers": [{
      "key": "sensor_motion",
      "device": "8C3066AA3F4E",
      "eventId": "6a34137603591903e404ef5e",
      "timestamp": 1781797750858
    }]
  },
  "timestamp": 1781797750931,
  "alarm_id": "019edb38-63c3-7403-8be2-dd9216e11227"
}
```

## PagerDuty deduplication

Production alarms are deduplicated by `alarm_id` + `device`, so repeated webhook deliveries for the same alarm will not create duplicate incidents. Test events (`alarm_id: "TEST"`) always create a new event.

