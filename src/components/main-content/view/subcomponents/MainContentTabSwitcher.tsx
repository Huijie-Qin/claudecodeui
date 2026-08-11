import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import { Tooltip, PillBar, Pill } from '../../../../shared/view/ui';
import type { AppTab } from '../../../../types/app';

import { buildMainContentTabs, type BuiltInMainContentTab } from './mainContentTabs';

type MainContentTabSwitcherProps = {
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  disabledTabs?: ReadonlySet<AppTab>;
};

type TabDefinition = BuiltInMainContentTab;

export default function MainContentTabSwitcher({
  activeTab,
  setActiveTab,
  disabledTabs,
}: MainContentTabSwitcherProps) {
  const { t } = useTranslation();
  const tabs: TabDefinition[] = buildMainContentTabs();

  return (
    <PillBar>
      {tabs.map((tab) => {
        const isActive = tab.id === activeTab;
        const isDisabled = disabledTabs?.has(tab.id) ?? false;
        const displayLabel = t(tab.labelKey);

        return (
          <Tooltip key={tab.id} content={displayLabel} position="bottom">
            <Pill
              isActive={isActive}
              disabled={isDisabled}
              onClick={() => {
                if (!isDisabled) {
                  setActiveTab(tab.id);
                }
              }}
              className="px-2.5 py-[5px]"
            >
              <tab.icon className="h-3.5 w-3.5" strokeWidth={isActive ? 2.2 : 1.8} />
              <span className="hidden lg:inline">{displayLabel}</span>
            </Pill>
          </Tooltip>
        );
      })}
    </PillBar>
  );
}
