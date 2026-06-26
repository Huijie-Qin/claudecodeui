import { aiMrSubmissionsDb } from '../database/db.js';
import { codeHubMcpService } from './codehub-mcp.js';

const DEFAULT_INTERVAL_MINUTES = 5;
const DEFAULT_BATCH_LIMIT = 50;

function readPositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function readIntervalMinutes() {
  const explicitMinutes = readPositiveNumber(process.env.CODEHUB_MR_POLL_INTERVAL_MINUTES, 0);
  if (explicitMinutes > 0) return explicitMinutes;
  const legacyHours = readPositiveNumber(process.env.CODEHUB_MR_POLL_INTERVAL_HOURS, 0);
  return legacyHours > 0 ? legacyHours * 60 : DEFAULT_INTERVAL_MINUTES;
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function mapMergeRequestStatus(info, now) {
  const state = String(info?.state || '').toLowerCase();
  if (info?.merged_at || state === 'merged') {
    return {
      status: 'merged',
      nextCheckAt: null,
      mergedAt: info?.merged_at || now.toISOString(),
      closedAt: info?.closed_at || null,
    };
  }
  if (state === 'closed' || state === 'rejected') {
    return {
      status: 'closed',
      nextCheckAt: null,
      mergedAt: null,
      closedAt: info?.closed_at || now.toISOString(),
    };
  }
  return {
    status: 'pending',
    nextCheckAt: null,
    mergedAt: null,
    closedAt: null,
  };
}

export function createCodeHubMrPoller({
  submissionsDb = aiMrSubmissionsDb,
  mcpService = codeHubMcpService,
  intervalMinutes = readIntervalMinutes(),
  batchLimit = readPositiveNumber(process.env.CODEHUB_MR_POLL_BATCH_LIMIT, DEFAULT_BATCH_LIMIT),
  enabled = process.env.CODEHUB_MR_POLLER_ENABLED !== 'false',
} = {}) {
  let timer = null;
  let running = false;

  async function pollOnce() {
    if (!enabled || running) return;
    running = true;
    const now = new Date();
    try {
      const submissions = submissionsDb.listPendingDue({ now, limit: batchLimit });
      for (const submission of submissions) {
        const currentNow = new Date();
        const expiresAt = toDate(submission.expires_at);
        if (expiresAt && expiresAt.getTime() <= currentNow.getTime()) {
          submissionsDb.markExpired({ submissionId: submission.id, checkedAt: currentNow });
          continue;
        }
        if (!submission.mr_iid || !submission.mr_project_id) {
          submissionsDb.updateMrStatus({
            submissionId: submission.id,
            status: 'pending',
            mrState: submission.mr_state,
            checkedAt: currentNow,
            nextCheckAt: addMinutes(currentNow, intervalMinutes).toISOString(),
            lastError: 'Missing merge request project id or iid',
          });
          continue;
        }

        try {
          const info = await mcpService.getMergeRequestInfo({
            userId: submission.user_id,
            projectId: submission.mr_project_id,
            mergeRequestIid: submission.mr_iid,
          });
          const mapped = mapMergeRequestStatus(info, currentNow);
          const nextCheckAt = mapped.status === 'pending'
            ? addMinutes(currentNow, intervalMinutes).toISOString()
            : null;
          submissionsDb.updateMrStatus({
            submissionId: submission.id,
            status: mapped.status,
            mrState: info?.state || submission.mr_state,
            mrCreatedAt: info?.created_at || null,
            mrUpdatedAt: info?.updated_at || null,
            mergedAt: mapped.mergedAt,
            closedAt: mapped.closedAt,
            checkedAt: currentNow,
            nextCheckAt,
            lastError: null,
          });
        } catch (error) {
          const checkedAt = new Date();
          submissionsDb.updateMrStatus({
            submissionId: submission.id,
            status: 'pending',
            mrState: submission.mr_state,
            checkedAt,
            nextCheckAt: addMinutes(checkedAt, intervalMinutes).toISOString(),
            lastError: error?.message || String(error),
          });
        }
      }
    } catch (error) {
      console.error('[CodeHub MR Poller] Failed to poll merge requests:', error);
    } finally {
      running = false;
    }
  }

  function start() {
    if (!enabled || timer) return;
    if (!process.env.CODEHUB_MCP_URL) {
      console.warn('[CodeHub MR Poller] CODEHUB_MCP_URL is not configured; poller is disabled');
      return;
    }
    void pollOnce();
    timer = setInterval(() => {
      void pollOnce();
    }, intervalMinutes * 60 * 1000);
    timer.unref?.();
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return {
    start,
    stop,
    pollOnce,
  };
}

export const codeHubMrPoller = createCodeHubMrPoller();
