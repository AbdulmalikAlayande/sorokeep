import { getLogger } from "../logging/index.js";
import type { AlertEvent } from "./types.js";

const logger = getLogger().child({ component: "SNSHandler" });

const DEFAULT_REGION = "us-east-1";

function isValidSnsTopicArn(topicArn: string): boolean {
    const normalized = topicArn.trim();
    if (!normalized) return false;

    // AWS SNS topic ARNs are of the form:
    // arn:partition:sns:region:account-id:topic-name
    return /^arn:(aws[a-zA-Z-]*):sns:[a-z0-9-]+:\d{12}:[^:\s]+$/.test(normalized);
}

export async function sendSnsAlert(topicArn: string, event: AlertEvent): Promise<void> {
    const normalizedArn = topicArn.trim();

    if (!isValidSnsTopicArn(normalizedArn)) {
        throw new Error(`Invalid SNS topic ARN: ${topicArn}`);
    }

    logger.debug("Publishing alert to SNS topic", {
        topicArn: normalizedArn,
        type: event.type,
        contractId: event.contractId,
    });

    const { SNSClient, PublishCommand } = await import("@aws-sdk/client-sns");

    const region = process.env["AWS_REGION"] ?? process.env["AWS_DEFAULT_REGION"] ?? DEFAULT_REGION;

    const client = new SNSClient({
        region,
    });

    const command = new PublishCommand({
        TopicArn: normalizedArn,
        Message: JSON.stringify(event),
    });

    await client.send(command);

    logger.debug("SNS alert published successfully", { topicArn: normalizedArn, type: event.type });
}
