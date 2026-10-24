// Only server-authored aliases may be passed. The all snapshot ID is a digest,
// never a tenant/batch database key. Each tenant contributes its own publication.
export function publishedTenantWhere(alias) {
  return `${alias}.tenant_id IN (SELECT scope_state.tenant_id FROM ai_usage_tenant_state scope_state
    JOIN ai_usage_batches scope_batch ON scope_batch.id=scope_state.active_batch_id
      AND scope_batch.tenant_id=scope_state.tenant_id AND scope_batch.status='published'
    JOIN tenants scope_tenant ON scope_tenant.id=scope_state.tenant_id
    WHERE ((@allTenants=1 AND scope_tenant.status='active')
        OR (@allTenants=0 AND scope_state.tenant_id=@tenant AND scope_state.active_batch_id=@batch)))`;
}
