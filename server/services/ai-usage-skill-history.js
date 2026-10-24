// Only an explicitly imported historical publication can authorize a name-based
// match. Ordinary marketplace names and current installs are not historical proof.
export const HISTORICAL_SKILL_PUBLICATION_PREFIX = 'historical-skill-publication:';

export function createHistoricalSkillResolver(database, tenantId) {
  const publications = database.prepare(`SELECT operation_id,user_id,skill_id,skill_name,first_published_at
    FROM ai_skill_publications WHERE tenant_id=? AND skill_name=? AND status='confirmed'
      AND skill_id IS NOT NULL AND first_published_at IS NOT NULL
    UNION ALL SELECT id AS operation_id,user_id,skill_id,skill_name,published_at AS first_published_at
    FROM ai_skill_publish_events WHERE tenant_id=? AND skill_name=? AND status='succeeded'
      AND skill_id IS NOT NULL AND published_at IS NOT NULL`);
  const cache = new Map();
  const isHistorical = row => typeof row.operation_id === 'string'
    && row.operation_id.startsWith(HISTORICAL_SKILL_PUBLICATION_PREFIX);
  const resolve = (name, occurredAt) => {
    if (typeof name !== 'string' || !name.trim() || !Number.isFinite(Date.parse(occurredAt))) {
      return { match: null, reason: 'historical_mapping_missing' };
    }
    name = name.trim();
    if (!cache.has(name)) cache.set(name, publications.all(tenantId, name, tenantId, name));
    const records = cache.get(name);
    const eligible = records.filter(row => Date.parse(row.first_published_at) <= Date.parse(occurredAt));
    const historical = eligible.filter(isHistorical);
    if (!historical.length) return { match: null, reason: records.some(isHistorical)
      ? 'historical_publication_after_call' : 'historical_mapping_missing' };
    // A competing confirmed publication also makes the name ambiguous, even if
    // only one of the owners supplied a historical backfill. Never select first.
    const identities = new Set(eligible.map(row => JSON.stringify([row.skill_id, row.user_id])));
    if (identities.size !== 1) return { match: null, reason: 'historical_name_ambiguous' };
    const row = historical.reduce((first, next) => Date.parse(next.first_published_at) < Date.parse(first.first_published_at) ? next : first);
    return { match: { skillId: row.skill_id, skillName: row.skill_name, publisherUserId: row.user_id,
      firstPublishedAt: row.first_published_at }, reason: null };
  };
  resolve.clear = () => cache.clear();
  return resolve;
}
