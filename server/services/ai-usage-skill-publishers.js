// A market account ID is not a platform user ID. Resolve only from a trusted
// binding or this tenant's confirmed publication of the exact remote Skill ID.
export function createSkillPublisherResolver(database, tenantId) {
  const publications = database.prepare(`SELECT DISTINCT user_id,first_published_at FROM ai_skill_publications
    WHERE tenant_id=? AND skill_id=? AND status='confirmed' AND first_published_at IS NOT NULL`);
  const cache = new Map();
  return (binding, occurredAt) => {
    if (!cache.has(binding.remote_skill_id)) cache.set(binding.remote_skill_id,
      publications.all(tenantId, binding.remote_skill_id));
    const candidates = new Set(cache.get(binding.remote_skill_id)
      .filter((row) => Date.parse(row.first_published_at) <= Date.parse(occurredAt))
      .map((row) => row.user_id));
    if (binding.publisher_user_id != null) candidates.add(binding.publisher_user_id);
    // Missing or conflicting evidence must never turn the caller into author.
    return candidates.size === 1 ? [...candidates][0] : null;
  };
}
