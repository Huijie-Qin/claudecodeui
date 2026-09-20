import { createContext, useContext, useEffect, useState, type SetStateAction } from 'react';

import { restoreReportView, type ReportViewStore } from './reportViewState';

export const ReportViewContext = createContext<ReportViewStore | null>(null);

export function useReportView<T extends { page: number }>(key: string, queryKey: string, defaults: T): [T, (next: SetStateAction<T>) => void] {
  const store = useContext(ReportViewContext);
  const [state, setState] = useState<T>(() => restoreReportView(store, key, queryKey, defaults));
  useEffect(() => { store?.set(key, { queryKey, value: state }); }, [store, key, queryKey, state]);
  return [state, setState];
}
