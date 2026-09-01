type InvitationFailurePayload = {
  code?: string;
  error?: string;
} | null;

export function shouldRedirectAcceptedInvitation(
  responseStatus: number,
  payload: InvitationFailurePayload,
): boolean {
  if (responseStatus !== 410) return false;

  return payload?.code === 'INVITATION_ALREADY_ACCEPTED'
    // Keep compatibility with an older backend that does not return the response code yet.
    || payload?.error === '该邀请已被接受';
}
