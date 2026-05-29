import React, { useEffect, useMemo, useRef, useState } from 'react';

type TimestampValue = string | number | Date | null | undefined;

interface ToolCompletionTimeBadgeProps {
  completedAt?: TimestampValue;
  isComplete?: boolean;
  className?: string;
}

function timestampToMs(value: TimestampValue): number | null {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string') {
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : null;
  }

  return null;
}

export const ToolCompletionTimeBadge: React.FC<ToolCompletionTimeBadgeProps> = ({
  completedAt,
  isComplete = false,
  className = '',
}) => {
  const completedMs = useMemo(() => timestampToMs(completedAt), [completedAt]);
  const [fallbackCompletedMs, setFallbackCompletedMs] = useState<number | null>(null);
  const hasRenderedRunningRef = useRef(!isComplete);

  useEffect(() => {
    if (!isComplete) {
      hasRenderedRunningRef.current = true;
      setFallbackCompletedMs(null);
      return undefined;
    }

    if (completedMs === null && hasRenderedRunningRef.current) {
      setFallbackCompletedMs((existing) => existing ?? Date.now());
    }

    return undefined;
  }, [completedMs, isComplete]);

  if (!isComplete) {
    return null;
  }

  const displayedCompletedMs = completedMs ?? fallbackCompletedMs;
  if (displayedCompletedMs === null) {
    return null;
  }

  return (
    <span
      className={`inline-flex flex-shrink-0 items-center text-xs text-muted-foreground ${className}`}
    >
      {new Date(displayedCompletedMs).toLocaleTimeString()}
    </span>
  );
};
