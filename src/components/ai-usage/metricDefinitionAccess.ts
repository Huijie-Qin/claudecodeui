import { createContext, useContext } from 'react';

// Supplied by the server's live system-admin check, never by tenant role.
export const MetricDefinitionAccess = createContext(false);
export function useMetricDefinitions() { return useContext(MetricDefinitionAccess); }
