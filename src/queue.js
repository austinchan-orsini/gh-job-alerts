/**
 * queue.js — SQS wrapper for the job-alert event pipeline.
 *
 * poller.js (producer) publishes one message per new job; alert-worker.js
 * (consumer) long-polls and fans each one out to SMS/Discord/bot.
 *
 * Points at AWS_ENDPOINT_URL when set (LocalStack, for local/dev use — no
 * AWS account or cost required) or real AWS SQS otherwise (e.g. in
 * production, where LocalStack isn't available), with no code difference
 * between the two: same SDK calls, same message shape. SQS's free tier
 * (1M requests/month) has no 12-month expiration, so real AWS SQS is $0
 * at this app's volume even in production.
 */

import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
} from "@aws-sdk/client-sqs";

export function createSqsClient() {
  const { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY } = process.env;
  return new SQSClient({
    region: process.env.AWS_REGION || "us-east-1",
    endpoint: process.env.AWS_ENDPOINT_URL || undefined,
    // Explicit when creds are provided (LocalStack's dummy ones, or real AWS
    // ones); otherwise let the SDK's default provider chain figure it out
    // (e.g. an IAM role, if this ever runs somewhere that has one).
    credentials:
      AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY
        ? { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY }
        : undefined,
  });
}

const sqs = createSqsClient();
const QUEUE_NAME = process.env.JOB_ALERTS_QUEUE_NAME || "job-alerts";

// Resolved lazily (and cached) rather than hardcoded, because a queue URL's
// host reflects whatever endpoint created it — a URL fetched from the host
// (localhost:4566) isn't valid from inside a container (localstack:4566),
// and vice versa. Resolving by name against *this* process's own client
// always gets a URL valid in its own context. JOB_ALERTS_QUEUE_URL remains
// available as an explicit override (e.g. pointing at a real AWS queue).
let queueUrlPromise = null;

function queueUrl() {
  if (process.env.JOB_ALERTS_QUEUE_URL) return Promise.resolve(process.env.JOB_ALERTS_QUEUE_URL);
  if (!queueUrlPromise) {
    queueUrlPromise = sqs
      .send(new GetQueueUrlCommand({ QueueName: QUEUE_NAME }))
      .then((r) => r.QueueUrl)
      .catch((err) => {
        queueUrlPromise = null; // allow retry on next call instead of caching a failure
        throw new Error(
          `Could not resolve SQS queue "${QUEUE_NAME}" — run "npm run setup:queue" first ` +
            `(locally, or against real AWS by unsetting AWS_ENDPOINT_URL and using real credentials). (${err.message})`
        );
      });
  }
  return queueUrlPromise;
}

export async function publishJobAlert(message) {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: await queueUrl(),
      MessageBody: JSON.stringify(message),
    })
  );
}

/**
 * Long-polls the queue forever, calling handler(message) for each one and
 * deleting it on success. A handler error leaves the message in place —
 * SQS redelivers it after the visibility timeout, giving free retries.
 */
export async function receiveJobAlerts(handler) {
  console.log("[queue] Listening for job alerts…");
  const url = await queueUrl();
  while (true) {
    let result;
    try {
      result = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: url,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 20,
        })
      );
    } catch (err) {
      console.error("[queue] Receive failed, retrying in 5s:", err.message);
      await sleep(5000);
      continue;
    }

    for (const msg of result.Messages ?? []) {
      try {
        await handler(JSON.parse(msg.Body));
        await sqs.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: msg.ReceiptHandle }));
      } catch (err) {
        console.error("[queue] Handler failed, leaving message for redelivery:", err.message);
      }
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
