#!/usr/bin/env node
/**
 * scripts/setup-queue.js
 *
 * Idempotently creates the job-alerts SQS queue (against LocalStack in dev,
 * or real AWS if AWS_ENDPOINT_URL is unset and real credentials are
 * configured). Run once after `docker compose up`:
 *
 *   node scripts/setup-queue.js
 *
 * Prints the queue URL to paste into JOB_ALERTS_QUEUE_URL in .env if it
 * isn't already set there.
 */

import "dotenv/config";
import { CreateQueueCommand } from "@aws-sdk/client-sqs";
import { createSqsClient } from "../src/queue.js";

const QUEUE_NAME = process.env.JOB_ALERTS_QUEUE_NAME || "job-alerts";

const sqs = createSqsClient();
const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: QUEUE_NAME }));

console.log(`✅ Queue "${QUEUE_NAME}" ready: ${QueueUrl}`);
console.log(`The app resolves this by name at runtime, so no further .env changes are needed.`);
