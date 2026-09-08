// Validate the JSON value of one configured parameter without requiring other
// tool arguments: the model may supply those when it calls the tool.
export function isMcpParameterValueCompatible(value, schema) {
  if (schema === false) return false;
  if (!schema || typeof schema !== 'object') return true;
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => JSON.stringify(entry) === JSON.stringify(value))) return false;
  const matchesType = (type) => {
    switch (type) {
      case 'null': return value === null;
      case 'array': return Array.isArray(value);
      case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
      case 'integer': return typeof value === 'number' && Number.isInteger(value);
      case 'number': return typeof value === 'number' && Number.isFinite(value);
      case 'boolean': return typeof value === 'boolean';
      case 'string': return typeof value === 'string';
      default: return true;
    }
  };
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.some(matchesType)) return false;
  if (Array.isArray(value) && schema.items && !Array.isArray(schema.items)) {
    return value.every((entry) => isMcpParameterValueCompatible(entry, schema.items));
  }
  return true;
}
