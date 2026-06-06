/**
 * sms.js — send SMS alerts via Twilio.
 */

import twilio from "twilio";

let _client;

function getClient() {
  if (_client) return _client;
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    throw new Error("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set in .env");
  }
  _client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  return _client;
}

/**
 * Send an SMS for a new job posting.
 *
 * @param {object} job  { company, role, location, applyUrl }
 * @param {string} repoLabel  Human-readable repo label, e.g. "SimplifyJobs"
 * @returns {string} Twilio message SID
 */
export async function sendJobAlert(job, repoLabel) {
  const { TWILIO_FROM_NUMBER, TWILIO_TO_NUMBER } = process.env;
  if (!TWILIO_FROM_NUMBER || !TWILIO_TO_NUMBER) {
    throw new Error("TWILIO_FROM_NUMBER and TWILIO_TO_NUMBER must be set in .env");
  }

  const body = formatSms(job, repoLabel);

  const message = await getClient().messages.create({
    body,
    from: TWILIO_FROM_NUMBER,
    to: TWILIO_TO_NUMBER,
  });

  return message.sid;
}

/**
 * Format the SMS body. Kept short so it fits in 1 SMS segment (≤160 chars).
 */
function formatSms(job, repoLabel) {
  const parts = [`🆕 ${job.company}`, job.role];
  if (job.location) parts.push(`📍 ${job.location}`);
  if (repoLabel) parts.push(`[${repoLabel}]`);
  if (job.applyUrl) parts.push(job.applyUrl);

  let msg = parts.join("\n");

  // Truncate gracefully if over 1 SMS (320 chars = 2 segments max)
  if (msg.length > 320) {
    msg = msg.slice(0, 317) + "...";
  }

  return msg;
}
