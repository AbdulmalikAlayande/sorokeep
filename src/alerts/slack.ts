import type { AlertEvent } from "./types.js";
import { getLogger } from "../logging/index.js";

const logger = getLogger().child({ component: "SlackHandler" });
const SLACK_API_URL = "https://slack.com/api/chat.postMessage";
const TIMEOUT_MS = 10_000;

export async function sendSlackAlert(channel: string, event: any): Promise<void> {}