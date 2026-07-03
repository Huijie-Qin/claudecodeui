export type SqlCheckRule = {
  rule_id: string;
  name: string;
  desc: string;
};

const RULE_LIST_KEYS = ['response', 'rules', 'data', 'result', 'items', 'list', 'records'];
const RULE_ID_KEYS = ['rule_id', 'ruleId', 'id', 'code', 'key'];
const RULE_NAME_KEYS = ['name', 'rule_name', 'ruleName', 'title', 'label'];
const RULE_DESC_KEYS = ['desc', 'description', 'rule_desc', 'ruleDesc', 'summary'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getStringField(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (value === undefined || value === null) continue;

    const normalizedValue = String(value).trim();
    if (normalizedValue) return normalizedValue;
  }

  return '';
}

function looksLikeRule(value: unknown) {
  if (!isRecord(value)) return false;
  return getStringField(value, RULE_ID_KEYS).length > 0 || getStringField(value, RULE_NAME_KEYS).length > 0;
}

function findRulesArray(payload: unknown, depth = 0): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload) || depth > 3) return [];

  for (const key of RULE_LIST_KEYS) {
    if (!(key in payload)) continue;

    const nestedRules = findRulesArray(payload[key], depth + 1);
    if (nestedRules.length > 0) return nestedRules;
  }

  for (const value of Object.values(payload)) {
    if (Array.isArray(value) && value.some(looksLikeRule)) {
      return value;
    }
  }

  return [];
}

export function normalizeSqlCheckRules(payload: unknown): SqlCheckRule[] {
  const seenRuleIds = new Set<string>();

  return findRulesArray(payload)
    .filter(isRecord)
    .map((rule) => {
      const ruleId = getStringField(rule, RULE_ID_KEYS);
      const name = getStringField(rule, RULE_NAME_KEYS) || ruleId;

      return {
        rule_id: ruleId,
        name,
        desc: getStringField(rule, RULE_DESC_KEYS),
      };
    })
    .filter((rule) => {
      if (!rule.rule_id || !rule.name || seenRuleIds.has(rule.rule_id)) return false;
      seenRuleIds.add(rule.rule_id);
      return true;
    });
}
