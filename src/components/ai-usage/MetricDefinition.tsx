import type { ReactNode } from 'react';

import { useMetricDefinitions } from './metricDefinitionAccess';
export default function MetricDefinition({ children }: { children: ReactNode }) {
  return useMetricDefinitions() ? <>{children}</> : null;
}
