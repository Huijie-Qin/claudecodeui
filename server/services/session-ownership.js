import { multitenancyDb } from '../database/multitenancy-db.js';

export function createSessionOwnershipRecorder(multitenancy = multitenancyDb) {
  return function recordProviderSession({
    options = {},
    provider,
    providerSessionId,
    status = 'active',
  }) {
    if (!options.tenantId || !options.workspaceId || !options.userId || !providerSessionId) {
      return null;
    }

    return multitenancy.sessions.upsertSession({
      tenantId: options.tenantId,
      workspaceId: options.workspaceId,
      userId: options.userId,
      provider,
      providerSessionId,
      summary: options.sessionSummary || null,
      status,
      ...(options.sessionMetadata ? { metadata: options.sessionMetadata } : {}),
    });
  };
}

export const recordProviderSession = createSessionOwnershipRecorder(multitenancyDb);
