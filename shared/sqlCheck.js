/** Recognize the SQL Check capability without depending on its display label. */
export function isSqlCheckMcp(preset) {
  if (!preset) return false;
  if (preset.isSqlCheck === true) return true;
  const name = String(preset.serverName || preset.name || '').toLowerCase().replace(/[-_\s]/g, '');
  if (['sqlcheck', 'sqlsyntaxchecker'].includes(name)) return true;
  let tools = preset.tools;
  if (!Array.isArray(tools)) {
    try { tools = JSON.parse(preset.tools_json || '[]'); } catch { tools = []; }
  }
  return Array.isArray(tools) && tools.some((tool) => /(?:^|__)check_sql_syntax$/.test(String(tool?.name || '')));
}

/** @typedef {{ customEnabled: boolean, ruleIds: string[] }} SqlCheckSelection */

/** @param {unknown} value @returns {SqlCheckSelection | null} */
export function normalizeSqlCheckSelection(value) {
  if (value == null) return null;
  const invalid = () => Object.assign(new Error('sqlCheck must contain customEnabled (boolean) and ruleIds (an array of valid rule IDs)'), { statusCode: 400 });
  if (typeof value !== 'object' || Array.isArray(value)
    || !('customEnabled' in value) || typeof value.customEnabled !== 'boolean'
    || !('ruleIds' in value) || !Array.isArray(value.ruleIds)) throw invalid();
  const ruleIds = value.ruleIds.map((id) => {
    if (typeof id !== 'string' || !id.trim() || id.trim().length > 256 || /[\u0000-\u001f\u007f]/.test(id)) throw invalid();
    return id.trim();
  });
  return { customEnabled: value.customEnabled, ruleIds: [...new Set(ruleIds)] };
}
