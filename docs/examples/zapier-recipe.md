# Recipe: turn TTL alerts into no-code automations with Zapier or Make.com

Sorokeep's **`webhook`** alert channel already POSTs an HMAC-signed JSON payload to
any URL. That means no code is required to build automations on top of your
alerts — you can point sorokeep at a webhook URL provided by **Zapier** or
**Make.com**, then wire the incoming payload to a spreadsheet, a chat tool, a
ticketing system, or anything else those platforms support.

This recipe walks through the whole flow:

1. Create a webhook "trigger" in Zapier (or Make.com) and copy its URL.
2. Register that URL with sorokeep as a webhook alert.
3. Send a real test alert and confirm the automation actually fires.

No receiving server is required and **no code changes to sorokeep are needed** —
this documents the built-in webhook channel.

---

## Prerequisites

- A sorokeep installation with at least one contract registered (`sorokeep watch` done).
- A Zapier or Make.com account.
- (Recommended) a way to receive real alerts — e.g. a registered contract that you
  can test against.

---

## How sorokeep delivers webhook alerts (the contract this recipe relies on)

- On every alert, sorokeep **POSTs** a JSON body to the configured URL.
- The default body is the full `AlertEvent` object serialized as JSON (see
  [Example payload](#example-payload-delivered-by-sorokeep)).
- Request headers:
  - `Content-Type: application/json`
  - `X-Sorokeep-Signature: sha256=<hex>` — only when a webhook secret is configured
    (it is **auto-generated** for you when you add a `webhook` alert, unless you
    pass `--secret`).
- sorokeep expects a **2xx** response. Any other status is treated as a delivery
  failure and retried (up to the channel retry cap). Zapier and Make.com return
  `200` by default, so they work out of the box.
- Sending is subject to a **10-second** network timeout.

---

## Part A — Zapier: create a "Catch Hook" trigger

1. In Zapier, create a new Zap.
2. Search the **"Webhooks by Zapier"** app and choose the **"Catch Hook"** trigger.
   It asks for an event — pick anything descriptive like `sorokeep-alert`.
3. Zapier gives you a webhook URL that looks like
   `https://hooks.zapier.com/hooks/catch/<account>/<code>/`. **Copy it.**
4. Click **Test trigger**. Zapier will wait for you to POST to that URL before it
   can show you a sample. That is exactly what the sorokeep test command does
   (Part C) — run it, then come back to Zapier and click the test.

> When you test, Zapier sends you a payload. Choose the **"output options"**: for
> a generic webhook, select "JSON" so Zapier parses the delivered body into
> fields you can use in later steps (e.g. `contractId`, `severity`, `timestamp`).

---

## Part B — Make.com: create a custom webhook

1. In Make (formerly Integromat), create a scenario.
2. Add a **"Webhooks → Custom webhook"** module as the trigger.
3. Click **Add**, give it a name, and copy the generated **webhook address**.
4. Save. A **"Waiting for data"** status appears — Make is now waiting for
   sorokeep to POST to that URL (Part C).

---

## Part C — Register the webhook with sorokeep and send a test alert

Register a webhook alert for a contract, pointing at the Zapier/Make URL:

```bash
sorokeep alerts add \
  --contract <CONTRACT_ID> \
  --type webhook \
  --url https://hooks.zapier.com/hooks/catch/<account>/<code>/ \
  --threshold 20000
```

Or for Make.com, replace `--url` with your Make webhook address.

Notes:

- `--threshold` is the TTL (in ledgers) below which sorokeep fires an alert. It is
  required for TTL alerts. (Resource alerts use `--cpu-limit` / `--mem-limit`
  instead.)
- Because the channel is `webhook`, sorokeep **auto-generates a webhook secret**
  and prints it. **Save it** — see [Verifying the HMAC signature](#verifying-the-hmac-signature)
  for what to do with it.

Find the alert config's ID so you can test it:

```bash
sorokeep alerts list --contract <CONTRACT_ID>
```

### Send a real test alert

```bash
sorokeep alerts test --id <ALERT_CONFIG_ID>
```

If the URL is the Zapier catch-hook you created earlier, the Zap should now fire
automatically — check Zapier's **Test trigger** tab / Make scenario history.

To **see the exact payload and signature header without delivering**, use:

```bash
sorokeep alerts test --id <ALERT_CONFIG_ID> --dry-run
```

You can also confirm delivery through sorokeep's own history:

```bash
sorokeep alerts history --contract <CONTRACT_ID>
```

---

## Example: wiring alerts to a Google Sheet

Both Zapier and Make let you chain the webhook trigger to a spreadsheet module.

- **Zapier:** add a **"Google Sheets → Create Spreadsheet Row"** action after the
  Catch Hook. Map the payload's `contractId`, `severity`, `threshold.approximateTimeRemaining`,
  `network`, and `timestamp` fields to columns.
- **Make.com:** after the custom webhook add a **"Google Sheets → Add a Row"**
  module and map `data.contractId`, `data.severity`, etc. (Make exposes the body's
  fields under `data`; keep the path that matches your chosen output option).

The same approach applies to Slack/Discord messages, Notion databases, email
tickets, SMS, or any other tool — whatever you can point a no-code platform at.

---

## Example payload delivered by sorokeep

This is the **actual** default body sorokeep produces (JSON, one event). It was
generated from sorokeep's own event builder — no extra fields invented for this
recipe:

```json
{
  "type": "threshold_crossed",
  "severity": "warning",
  "contractId": "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  "contractName": "USD Stablecoin Gateway",
  "network": "testnet",
  "entry": {
    "keyXdr": "AAAAAfM8HhdF...",
    "type": "instance",
    "label": "Contract Instance"
  },
  "threshold": {
    "configuredLedgers": 20000,
    "currentRemainingLedgers": 9500,
    "approximateTimeRemaining": "~14h 30m"
  },
  "firedAtLedger": 48210359,
  "timestamp": "2026-08-30T09:47:23.372Z",
  "stellarExpertUrl": "https://testnet.stellar.expert/explorer/testnet/contract/CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
}
```

Corresponding request headers (with a sample secret):

```
Content-Type: application/json
X-Sorokeep-Signature: sha256=56cfe2103370678657f485b68876c7768ef6e32de98c00eb1c002bcd5854ab83
```

> The exact signature shown won't match a payload you deliver, because the
> timestamp and `stellarExpertUrl` differ per event. Compute the HMAC over the
> **exact** body string sorokeep sends and your configured `--secret` — see below.

Aside from `threshold_crossed`, sorokeep can deliver other event shapes:
`alert_resolved`, `resource_alert`, `state_changed`, and `budget_exhausted`
(same top-level contract/network/timestamp fields, plus a type-specific block).

---

## Verifying the HMAC signature

sorokeep signs every request with

```
X-Sorokeep-Signature: sha256=<hex>
```

where `<hex>` is the HMAC-SHA256 of the exact request body using your webhook
secret.

**The honest tradeoff:** neither Zapier's built-in Catch Hook nor Make.com's
custom webhook can verify an HMAC for you — that requires re-computing a hash
with your shared secret, which a purely no-code trigger cannot do. Two options:

1. **Accept the tradeoff (common for no-code).** The webhook URL is an unguessable
   random token (`/hooks/catch/<account>/<code>/`), so only someone who has that
   URL (or your sorokeep config) can POST to it. Treat the signature as
   defense-in-depth that you are choosing not to check in a no-code pipeline. This
   is a reasonable default IDPs and hobbyist setups.

2. **Verify before acting, using a *Code by Zapier* step.** If your automation
   performs expensive or destructive actions, verify the signature first. Because
   Zapier lets you keep the secret only in its registry, the cleanest approach is
   to store your sorokeep webhook secret in a key-value service (e.g. Zapier
   "Store" or a password manager) and recompute the hash in a **Code by Zapier**
   step placed right after the Catch Hook:

   ```js
   // Code by Zapier (JavaScript) — verify sorokeep's X-Sorokeep-Signature
   const crypto = require('crypto');
   const sig = inputData.signature;   // {{catchHook.header['X-Sorokeep-Signature']}}
   const raw  = inputData.rawBody;    // the raw body Zapier captured
   const secret = inputData.secret;   // your sorokeep webhook secret, from a store
   const expected = 'sha256=' +
     crypto.createHmac('sha256', secret).update(raw).digest('hex');
   const valid = inputData.signature === expected;
   if (!valid) throw new Error('Signature mismatch — dropping forged alert');
   output = [{ valid: true }];
   ```

   Set the Zap to **Stop** if this step throws, so only verified payloads reach
   the rest of your automation.

Make.com does not offer a comparable code step inside its free webhook trigger,
so the "accept the tradeoff" option (1) is the practical answer there; you can
still gate Make's scenario behind a webhook response check at sorokeep's side, or
use Zapier's Code step if you need signing verification.

---

## Using `webhook2` for custom headers / longer timeouts

`sorokeep alerts add --type webhook2 --url '<json>'` stores a JSON target instead
of a plain URL, letting you set custom headers and a timeout override (e.g. for a
private service that needs an API key header):

```bash
sorokeep alerts add \
  --contract <CONTRACT_ID> \
  --type webhook2 \
  --url '{"url":"https://hooks.zapier.com/hooks/catch/<account>/<code>/","headers":{"X-Api-Key":"<token>"},"timeoutMs":30000}' \
  --threshold 20000
```

The default `webhook` channel documented here is all you need for Zapier/Make;
`webhook2` exists for cases that need extra headers or a longer timeout.

---

## Troubleshooting

- **The Zap/Scenario doesn't fire after `alerts test`.**
  Confirm the URL was pasted exactly (Zapier catch-hook URLs are case-sensitive),
  then run `sorokeep alerts test --id <id> --dry-run` to confirm sorokeep considers
  the config valid, and check `sorokeep alerts history --contract <id>` shows a
  successful delivery.
- **Delivery shows failure in sorokeep history but Zapier looks fine.**
  sorokeep treats only **2xx** responses as success. The built-in Catch Hook
  returns `200`; if you used a custom step that returns another status, sorokeep
  will mark the delivery failed and retry.
- **Unrecognized fields in Make.** Make may flatten the body; use the field paths
  shown in Make's mapping modal (`data.contractId`, `data.severity`, ...) rather
  than assuming a fixed nesting. On Zapier, choose the **"JSON"** output option for
  the Catch Hook so fields are parsed.

---

## Security note

The webhook URL itself is a bearer credential — anyone who can POST to it can
inject a fake alert into your automation. Treat sorokeep's webhook secret like a
credential and **never commit it**. If your automation takes privileged actions
(delete/rotate, spend, page on-call), follow the [HMAC verification](#verifying-the-hmac-signature)
section and reject unverified payloads.