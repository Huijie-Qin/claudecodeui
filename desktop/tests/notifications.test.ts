import { describe, expect, it } from 'vitest';
import {
  isTrustedNotificationSender,
  NotificationRateLimiter,
  validateNotificationInput,
} from '../src/shared/notifications';

describe('desktop notification boundary', () => {
  it('accepts the typed notification payload and strips surrounding whitespace', () => {
    expect(validateNotificationInput({
      tag: ' session-123 ',
      title: ' Cloud task complete ',
      body: ' The response is ready. ',
      sessionId: 'abc-123',
    })).toEqual({
      tag: 'session-123',
      title: 'Cloud task complete',
      body: 'The response is ready.',
      sessionId: 'abc-123',
    });
  });

  it('rejects commands, unknown fields, control characters, and path-like session IDs', () => {
    expect(() => validateNotificationInput({
      tag: 'a',
      title: 'b',
      body: 'c',
      url: 'file:///etc/passwd',
    })).toThrow(/unsupported fields/u);
    expect(() => validateNotificationInput({
      tag: 'a',
      title: 'bad\u0000title',
      body: 'c',
    })).toThrow(/control/u);
    expect(() => validateNotificationInput({
      tag: 'a',
      title: 'spoof\u202etitle',
      body: 'c',
    })).toThrow(/control/u);
    expect(() => validateNotificationInput({
      tag: 'a',
      title: 'b',
      body: 'c',
      sessionId: '../../private/file',
    })).toThrow(/sessionId/u);
  });

  it('rejects forged IPC origins and subframes', () => {
    const origins = new Set(['https://cloudcli.example.com']);
    expect(isTrustedNotificationSender(
      'https://cloudcli.example.com/session/1',
      true,
      origins,
    )).toBe(true);
    expect(isTrustedNotificationSender(
      'https://cloudcli.example.com.evil.test/',
      true,
      origins,
    )).toBe(false);
    expect(isTrustedNotificationSender(
      'https://cloudcli.example.com/session/1',
      false,
      origins,
    )).toBe(false);
  });

  it('limits bursts and duplicate notification tags', () => {
    const limiter = new NotificationRateLimiter(2, 1_000, 200);
    expect(limiter.allow('one', 1_000)).toBe(true);
    expect(limiter.allow('one', 1_100)).toBe(false);
    expect(limiter.allow('two', 1_100)).toBe(true);
    expect(limiter.allow('three', 1_150)).toBe(false);
    expect(limiter.allow('three', 2_001)).toBe(true);
  });
});
