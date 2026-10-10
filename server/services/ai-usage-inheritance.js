// A fork carries historical context, not another execution of that history.
// Keep this check shared by native/DB indexing and live SDK replay handling.
export function isInheritedUsageMessage(raw) {
  const inherited = (value) => value?.inherited === true
    || Boolean(value?.forkedFrom && typeof value.forkedFrom === 'object');
  const envelope = raw?.type === 'claude-response' ? raw.data : raw;
  return inherited(raw) || inherited(envelope) || inherited(envelope?.message);
}

// column is a trusted SQL identifier supplied by the caller, never user input.
export function nonInheritedUsageMessageSql(column = 'normalized_json') {
  const marked = (prefix) => `(json_type(${column}, '${prefix}.inherited') IS 'true'
    OR json_type(${column}, '${prefix}.forkedFrom') IS 'object'
    OR json_type(${column}, '${prefix}.forkedFrom') IS 'array')`;
  return `NOT (${marked('$')}
    OR (json_extract(${column}, '$.type') IS 'claude-response'
      AND (${marked('$.data')} OR ${marked('$.data.message')}))
    OR (json_extract(${column}, '$.type') IS NOT 'claude-response' AND ${marked('$.message')}))`;
}
