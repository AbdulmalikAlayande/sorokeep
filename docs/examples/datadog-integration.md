# Datadog webhook forwarding for Sorokeep alerts

This recipe forwards Sorokeep webhook alerts into Datadog's Events API without changing the built-in webhook channel implementation. It is a minimal integration pattern for organizations that already use Datadog as their central observability platform.

## Overview

The flow is:

1. Sorokeep sends an alert to a small forwarding endpoint.
2. The forwarding function verifies the HMAC signature in `X-Sorokeep-Signature`.
3. The function converts the raw Sorokeep payload into a Datadog event.
4. The function posts the event to Datadog's Events API.

This works well when you already have a Datadog API key and want to keep Sorokeep's existing alert pipeline unchanged.

## 1. Configure the forwarding service

Use a lightweight Node.js server such as the one in [docs/examples/datadog-webhook-forwarder.mjs](datadog-webhook-forwarder.mjs).

Required environment variables:

```bash
export PORT=8081
export SOROKEEP_WEBHOOK_SECRET="replace-with-the-secret-generated-by-sorokeep"
export DD_API_KEY="your-datadog-api-key"
export DD_SITE="datadoghq.com"  # or datadoghq.eu / us3.datadoghq.com / etc.
```

Start it:

```bash
node docs/examples/datadog-webhook-forwarder.mjs
```

The server listens for POST requests and expects the webhook body exactly as Sorokeep sends it.

## 2. Add the Sorokeep webhook alert

Create or update the alert configuration so Sorokeep sends its webhook payload to your forwarding service instead of a raw endpoint.

Example:

```bash
sorokeep alerts add \
  --contract <CONTRACT_ID> \
  --type webhook \
  --url https://forwarder.example.com/webhook/datadog \
  --threshold 20000 \
  --secret "$SOROKEEP_WEBHOOK_SECRET"
```

If `--secret` is omitted, Sorokeep may still send a webhook but the forwarding endpoint cannot authenticate the request. For production, always set it.

The raw Sorokeep webhook body is a JSON object containing alert metadata such as:

```json
{
  "type": "threshold_crossed",
  "severity": "warning",
  "contractId": "CD...",
  "message": "TTL threshold crossed: remaining TTL 18200 ledgers",
  "threshold": 20000,
  "value": 18200,
  "timestamp": 1720000000000
}
```

## 3. Verify the signature before forwarding

Sorokeep signs the raw request body with HMAC-SHA256 using the configured webhook secret. The header format is:

```http
X-Sorokeep-Signature: sha256=<hex-digest>
```

The forwarding service verifies this before it passes any data to Datadog:

```js
const signature = req.headers["x-sorokeep-signature"];
const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) {
  res.statusCode = 401;
  res.end("invalid signature");
  return;
}
```

This prevents fake or tampered payloads from being forwarded into Datadog.

## 4. Convert to a Datadog event

Datadog's Events API accepts a single event object as JSON. The example forwarder maps the Sorokeep event into a Datadog event with a title, summary text, tags, and a source label.

Example Datadog payload:

```json
{
  "title": "Sorokeep alert: threshold_crossed",
  "text": "TTL threshold crossed: remaining TTL 18200 ledgers",
  "source_type_name": "sorokeep",
  "alert_type": "error",
  "priority": "normal",
  "tags": [
    "source:sorokeep",
    "contract:CD...",
    "severity:warning",
    "alert_type:threshold_crossed"
  ],
  "date_happened": 1720000000
}
```

The forwarder sends the event to Datadog with the API key in the `DD-API-KEY` header:

```http
POST https://api.datadoghq.com/api/v2/events
Content-Type: application/json
DD-API-KEY: <datadog-api-key>
```

## 5. Datadog example

A resulting Datadog event will look similar to this:

```text
Sorokeep alert: threshold_crossed

TTL threshold crossed: remaining TTL 18200 ledgers

Tags: source:sorokeep, contract:CD..., severity:warning, alert_type:threshold_crossed
```

This appears in Datadog Events as a searchable, taggable event stream that can be correlated with other logs, metrics, and dashboards.

## 6. Minimal verification checklist

Before going live, confirm the following:

- The forwarding service is reachable from the internet or a private network.
- `SOROKEEP_WEBHOOK_SECRET` matches the secret configured in Sorokeep.
- `DD_API_KEY` is valid and has permission to create events.
- The Datadog site matches the region you selected (`datadoghq.com`, `datadoghq.eu`, etc.).
- The webhook test command succeeds and the event appears in Datadog Events.

## 7. Manual smoke test

From a shell, send a signed test payload to the forwarder:

```bash
body='{"type":"threshold_crossed","severity":"warning","contractId":"CDTEST","message":"TTL threshold crossed","threshold":20000,"value":18200,"timestamp":1720000000000}'
expected=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$SOROKEEP_WEBHOOK_SECRET" -binary | xxd -p -c 256)
curl -X POST https://forwarder.example.com/webhook/datadog \
  -H "Content-Type: application/json" \
  -H "X-Sorokeep-Signature: sha256=$expected" \
  --data "$body"
```

Then check Datadog Events for the new entry.

## Notes

- This is a recipe, not a new Sorokeep feature.
- It keeps Sorokeep's native webhook delivery intact and adds a forwarding layer for Datadog integration.
- If you already expose a private network endpoint, you can run the forwarder behind a reverse proxy, load balancer, or Cloudflare Tunnel with the same verification logic.
