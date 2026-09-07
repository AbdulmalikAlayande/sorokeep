import http from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";

const port = Number(process.env.PORT ?? 8081);
const webhookSecret = process.env.SOROKEEP_WEBHOOK_SECRET;
const datadogApiKey = process.env.DD_API_KEY;
const datadogSite = process.env.DD_SITE ?? "datadoghq.com";

if (!webhookSecret) {
  throw new Error("SOROKEEP_WEBHOOK_SECRET is required");
}

if (!datadogApiKey) {
  throw new Error("DD_API_KEY is required");
}

const datadogEventsUrl = `https://api.${datadogSite}/api/v2/events`;

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Method not allowed");
    return;
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const bodyBuffer = Buffer.concat(chunks);
  const rawBody = bodyBuffer.toString("utf8");
  const headerValue = req.headers["x-sorokeep-signature"];

  if (typeof headerValue !== "string") {
    res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Missing X-Sorokeep-Signature");
    return;
  }

  const expectedSignature = `sha256=${createHmac("sha256", webhookSecret).update(rawBody).digest("hex")}`;
  const providedSignature = Buffer.from(headerValue);
  const expectedSignatureBuffer = Buffer.from(expectedSignature);

  if (
    providedSignature.length !== expectedSignatureBuffer.length ||
    !timingSafeEqual(providedSignature, expectedSignatureBuffer)
  ) {
    res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Invalid signature");
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Request body is not valid JSON");
    return;
  }

  const body = {
    title: payload.title ?? `Sorokeep alert: ${payload.type ?? "event"}`,
    text:
      typeof payload.message === "string"
        ? payload.message
        : JSON.stringify(payload, null, 2),
    source_type_name: "sorokeep",
    alert_type: payload.severity === "critical" ? "error" : "warning",
    priority: payload.severity === "critical" ? "normal" : "normal",
    date_happened: Math.floor((payload.timestamp ?? Date.now()) / 1000),
    tags: [
      "source:sorokeep",
      `contract:${payload.contractId ?? "unknown"}`,
      `severity:${payload.severity ?? "info"}`,
      ...(payload.type ? [`alert_type:${payload.type}`] : []),
    ],
  };

  try {
    const response = await fetch(datadogEventsUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "DD-API-KEY": datadogApiKey,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Datadog rejected the event: ${response.status} ${errorText}`);
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Failed to forward to Datadog");
      return;
    }

    res.writeHead(202, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, forwarded: true }));
  } catch (error) {
    console.error("Datadog forwarding failed:", error);
    res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Datadog forwarding failed");
  }
});

server.listen(port, () => {
  console.log(`Datadog webhook forwarder listening on http://localhost:${port}`);
});
