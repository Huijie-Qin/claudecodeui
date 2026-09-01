export type SkillsView = 'market' | 'mine';

type SkillTabClickDecisionOptions = {
  currentView: SkillsView;
  nextView: SkillsView;
  marketLoading: boolean;
  mineLoading: boolean;
};

export type SkillTabClickDecision = {
  shouldSwitch: boolean;
  refreshView: SkillsView | null;
};

export function getSkillTabClickDecision({
  currentView,
  nextView,
  marketLoading,
  mineLoading,
}: SkillTabClickDecisionOptions): SkillTabClickDecision {
  const targetLoading = nextView === 'market' ? marketLoading : mineLoading;
  return {
    shouldSwitch: currentView !== nextView,
    refreshView: targetLoading ? null : nextView,
  };
}
