export interface ValidatedNotificationInput {
  tag: string;
  title: string;
  body: string;
  sessionId?: string;
}

export function isTrustedNotificationSender(
  senderUrl: string,
  isMainFrame: boolean,
  allowedOrigins: ReadonlySet<string>,
): boolean {
  if (!isMainFrame) {
    return false;
  }
  try {
    const parsed = new URL(senderUrl);
    return !parsed.username
      && !parsed.password
      && allowedOrigins.has(parsed.origin);
  } catch {
    return false;
  }
}

const TAG_MAX_LENGTH = 128;
const TITLE_MAX_LENGTH = 120;
const BODY_MAX_LENGTH = 1024;
const SESSION_ID_MAX_LENGTH = 160;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const SINGLE_LINE_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

function cleanRequiredText(
  value: unknown,
  name: string,
  maximumLength: number,
  allowLineBreaks = false,
): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${name} must be a string.`);
  }

  const cleaned = value.trim();
  if (!cleaned || cleaned.length > maximumLength) {
    throw new TypeError(`${name} must contain 1-${maximumLength} characters.`);
  }

  const disallowed = allowLineBreaks
    ? CONTROL_CHARACTERS
    : SINGLE_LINE_CONTROL_CHARACTERS;
  if (disallowed.test(cleaned)) {
    throw new TypeError(`${name} contains control characters.`);
  }
  return cleaned;
}

export function validateNotificationInput(input: unknown): ValidatedNotificationInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Notification input must be an object.');
  }

  const candidate = input as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (keys.some((key) => !['tag', 'title', 'body', 'sessionId'].includes(key))) {
    throw new TypeError('Notification input contains unsupported fields.');
  }

  const result: ValidatedNotificationInput = {
    tag: cleanRequiredText(candidate.tag, 'tag', TAG_MAX_LENGTH),
    title: cleanRequiredText(candidate.title, 'title', TITLE_MAX_LENGTH),
    body: cleanRequiredText(candidate.body, 'body', BODY_MAX_LENGTH, true),
  };

  if (candidate.sessionId !== undefined) {
    const sessionId = cleanRequiredText(
      candidate.sessionId,
      'sessionId',
      SESSION_ID_MAX_LENGTH,
    );
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new TypeError('sessionId contains unsupported characters.');
    }
    result.sessionId = sessionId;
  }

  return result;
}

export class NotificationRateLimiter {
  private readonly timestamps: number[] = [];
  private readonly recentlySeenTags = new Map<string, number>();

  constructor(
    private readonly maximumNotifications = 6,
    private readonly windowMilliseconds = 10_000,
    private readonly duplicateWindowMilliseconds = 2_000,
  ) {}

  allow(tag: string, now = Date.now()): boolean {
    while (
      this.timestamps.length > 0
      && this.timestamps[0] <= now - this.windowMilliseconds
    ) {
      this.timestamps.shift();
    }

    for (const [seenTag, timestamp] of this.recentlySeenTags) {
      if (timestamp <= now - this.duplicateWindowMilliseconds) {
        this.recentlySeenTags.delete(seenTag);
      }
    }

    const previousTagTimestamp = this.recentlySeenTags.get(tag);
    if (
      previousTagTimestamp !== undefined
      && previousTagTimestamp > now - this.duplicateWindowMilliseconds
    ) {
      return false;
    }
    if (this.timestamps.length >= this.maximumNotifications) {
      return false;
    }

    this.timestamps.push(now);
    this.recentlySeenTags.set(tag, now);
    return true;
  }
}
