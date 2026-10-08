export type SkillCreationDraft = { mode: boolean; description: string; requestId?: string; sent?: string };

export function acceptSkillCreationDraft(draft: SkillCreationDraft, description: string): SkillCreationDraft {
  return { ...draft, description: draft.description === description ? '' : draft.description };
}

export function finishSkillCreationDraft(draft: SkillCreationDraft, job: { status: string; description: string }): SkillCreationDraft {
  const description = draft.description || (job.status === 'completed' ? '' : job.description);
  return { mode: Boolean(description), description };
}
