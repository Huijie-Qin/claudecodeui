export function isSkillCreator(createUserId, currentUsername) {
  return Boolean(
    createUserId
    && currentUsername
    && String(createUserId).toLowerCase() === String(currentUsername).toLowerCase()
  );
}
