const VALID_RESULT_STATUSES = new Set(['running', 'completed', 'failed', 'partial']);
const VALID_ARTIFACT_TYPES = new Set(['dataset', 'file', 'report', 'other']);

function normalizeStrings(value, maximum = 50) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean))].slice(0, maximum);
}

function clampConfidence(value, fallback = 0.5) {
  const confidence = Number(value);
  return Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : fallback;
}

function normalizeArtifactReference(value, knownArtifacts) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const artifactId = typeof value.artifactId === 'string' ? value.artifactId.trim() : '';
  if (!artifactId || !knownArtifacts.has(artifactId)) return null;
  const registered = knownArtifacts.get(artifactId);
  const requestedType = typeof value.type === 'string' ? value.type.trim().toLowerCase() : '';
  const type = VALID_ARTIFACT_TYPES.has(requestedType)
    ? requestedType
    : registered?.type || 'other';
  return {
    artifactId,
    type,
    description: (typeof value.description === 'string' && value.description.trim()
      ? value.description.trim()
      : registered?.name || artifactId).slice(0, 1_000),
  };
}

function normalizeArtifactReferences(value, availableArtifacts = [], automaticArtifactIds = []) {
  const knownArtifacts = new Map((Array.isArray(availableArtifacts) ? availableArtifacts : [])
    .filter((entry) => entry?.artifactId)
    .map((entry) => [entry.artifactId, entry]));
  const requested = Array.isArray(value) ? value : [];
  const normalized = requested
    .map((entry) => normalizeArtifactReference(entry, knownArtifacts))
    .filter(Boolean);
  const referencedIds = new Set(normalized.map((entry) => entry.artifactId));
  for (const artifactId of automaticArtifactIds) {
    const artifact = knownArtifacts.get(artifactId);
    if (!artifact) continue;
    if (referencedIds.has(artifact.artifactId)) continue;
    normalized.push({
      artifactId: artifact.artifactId,
      type: artifact.type || 'other',
      description: artifact.name || artifact.artifactId,
    });
  }
  return normalized.slice(0, 100);
}

function normalizeFinding(value, defaultConfidence, validArtifactIds) {
  if (typeof value === 'string') {
    const content = value.trim();
    return content ? { content, sourceArtifacts: [], confidence: defaultConfidence } : null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const content = typeof value.content === 'string' ? value.content.trim() : '';
  if (!content) return null;
  const sourceArtifacts = normalizeStrings(value.sourceArtifacts)
    .filter((artifactId) => validArtifactIds.has(artifactId));
  return {
    content,
    sourceArtifacts,
    confidence: clampConfidence(value.confidence, defaultConfidence),
  };
}

function parseJsonObject(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  let content = String(raw || '').trim();
  const fenced = content.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) content = fenced[1].trim();
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start !== -1 && end > start) content = content.slice(start, end + 1);
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export function extractAgentResult({ raw, fallbackText = '', availableArtifacts = [], automaticArtifactIds = [] }) {
  const parsed = parseJsonObject(raw);
  if (!parsed) {
    const message = String(fallbackText || raw || '').trim();
    if (!message) {
      const error = new Error('Agent Runtime returned an empty result');
      error.statusCode = 502;
      throw error;
    }
    return {
      status: 'partial',
      message,
      artifacts: normalizeArtifactReferences([], availableArtifacts, automaticArtifactIds),
      findings: [{ content: message, sourceArtifacts: [], confidence: 0.5 }],
      questions: [],
    };
  }

  // Old AgentResult is accepted for persisted Session and test compatibility.
  const message = String(parsed.message ?? parsed.summary ?? fallbackText ?? '').trim();
  if (!message) {
    const error = new Error('Agent Runtime returned an empty result message');
    error.statusCode = 502;
    throw error;
  }
  const statusValue = typeof parsed.status === 'string' ? parsed.status.trim().toLowerCase() : 'completed';
  const status = VALID_RESULT_STATUSES.has(statusValue) ? statusValue : 'completed';
  let artifacts = normalizeArtifactReferences(parsed.artifacts, availableArtifacts, automaticArtifactIds);
  const knownArtifacts = new Map(availableArtifacts.map((entry) => [entry.artifactId, entry]));
  const artifactIds = new Set(knownArtifacts.keys());
  const defaultConfidence = clampConfidence(parsed.confidence, 0.5);
  const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];
  const findings = rawFindings
    .map((entry) => normalizeFinding(entry, defaultConfidence, artifactIds))
    .filter(Boolean)
    .slice(0, 50);
  const referencedArtifactIds = new Set(findings.flatMap((entry) => entry.sourceArtifacts));
  const resultArtifactIds = new Set(artifacts.map((entry) => entry.artifactId));
  for (const artifactId of referencedArtifactIds) {
    if (resultArtifactIds.has(artifactId)) continue;
    const artifact = knownArtifacts.get(artifactId);
    if (!artifact) continue;
    artifacts.push({ artifactId, type: artifact.type || 'other', description: artifact.name || artifactId });
    resultArtifactIds.add(artifactId);
  }
  artifacts = artifacts.slice(0, 100);
  return {
    status,
    message,
    artifacts,
    findings,
    questions: normalizeStrings(parsed.questions ?? parsed.newQuestions),
  };
}

export function formatAgentResult(result) {
  const sections = [`Status: ${result.status}`, result.message];
  if (result.artifacts.length) {
    sections.push(`Artifacts:\n${result.artifacts.map((entry) => `- ${entry.artifactId} (${entry.type}): ${entry.description}`).join('\n')}`);
  }
  if (result.findings.length) {
    sections.push(`Findings:\n${result.findings.map((entry) => `- ${entry.content}`).join('\n')}`);
  }
  if (result.questions.length) {
    sections.push(`Questions:\n${result.questions.map((entry) => `- ${entry}`).join('\n')}`);
  }
  return sections.join('\n\n');
}
