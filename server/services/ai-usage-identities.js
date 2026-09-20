// Resolve display labels independently of the IDs used for authorization,
// grouping and drilldowns. Only small identity tables / published snapshots are
// read here; this never scans raw messages or Hook payloads.
export function reportUserNameSql(actor = 'user_id') {
  return `CASE WHEN report.${actor} IS NOT NULL THEN COALESCE(
    (SELECT NULLIF(TRIM(u.username),'') FROM users u WHERE u.id=report.${actor}),
    CASE WHEN json_type(value_json,'$.userName')='text' THEN NULLIF(TRIM(json_extract(value_json,'$.userName')),'') END) END`;
}

export const reportWorkspaceNameSql = `CASE WHEN report.workspace_id IS NOT NULL THEN COALESCE(
  (SELECT NULLIF(TRIM(w.display_name),'') FROM workspaces w WHERE w.id=report.workspace_id AND w.tenant_id=@tenant),
  CASE WHEN json_type(value_json,'$.workspaceName')='text' THEN NULLIF(TRIM(json_extract(value_json,'$.workspaceName')),'') END) END`;

export const reportIdentityColumns = `${reportUserNameSql()} AS userName, ${reportWorkspaceNameSql} AS workspaceName`;
export const reportIdentitySorts = { userName: 'userName', workspaceName: 'workspaceName' };
