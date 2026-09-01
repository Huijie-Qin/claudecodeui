import React, { useState } from 'react';

import { copyTextToClipboard } from '../../../../utils/clipboard';

import { ToolStatusBadge } from './ToolStatusBadge';
import type { ToolStatus } from './ToolStatusBadge';

type ActionType = 'copy' | 'open-file' | 'jump-to-results' | 'none';

interface OneLineDisplayProps {
  toolName: string;
  icon?: string;
  label?: string;
  value: string;
  secondary?: string;
  action?: ActionType;
  onAction?: () => void;
  wrapText?: boolean;
  colorScheme?: {
    primary?: string;
    secondary?: string;
    background?: string;
    border?: string;
    icon?: string;
  };
  resultId?: string;
  toolResult?: any;
  toolId?: string;
  status?: ToolStatus;
  completionTime?: React.ReactNode;
}

/**
 * Unified one-line display for simple tool inputs and results
 * Used by: Bash, Read, Grep/Glob (minimized), TodoRead, etc.
 */
export const OneLineDisplay: React.FC<OneLineDisplayProps> = ({
  toolName,
  icon,
  label,
  value,
  secondary,
  action = 'none',
  onAction,
  wrapText = false,
  colorScheme = {
    primary: 'text-foreground',
    secondary: 'text-muted-foreground',
    background: '',
    border: 'border-border',
    icon: 'text-muted-foreground',
  },
  toolResult,
  toolId,
  status,
  completionTime,
}) => {
  const [copied, setCopied] = useState(false);

  const handleAction = async () => {
    if (action === 'copy' && value) {
      const didCopy = await copyTextToClipboard(value);
      if (!didCopy) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else if (onAction) {
      onAction();
    }
  };

  const renderCopyButton = () => (
    <button
      onClick={handleAction}
      className="ml-1 flex-shrink-0 text-muted-foreground/40 opacity-0 transition-all hover:text-muted-foreground group-hover:opacity-100"
      title="Copy to clipboard"
      aria-label="Copy to clipboard"
    >
      {copied ? (
        <svg className="h-3 w-3 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
      )}
    </button>
  );

  // File open style
  if (action === 'open-file') {
    const displayName = value.split('/').pop() || value;
    return (
      <div className={`group flex items-center gap-1.5 border-l-2 ${colorScheme.border} my-0.5 py-0.5 pl-3`}>
        <span className="flex-shrink-0 text-xs text-muted-foreground">{label || toolName}</span>
        <span className="text-[10px] text-muted-foreground/40">/</span>
        <button
          onClick={handleAction}
          className="min-w-0 truncate font-mono text-xs text-primary transition-colors hover:text-primary/80 hover:underline"
          title={value}
        >
          {displayName}
        </button>
        {completionTime}
        {status && <ToolStatusBadge status={status} className="ml-auto" />}
      </div>
    );
  }

  // Search / jump-to-results style
  if (action === 'jump-to-results') {
    return (
      <div className={`group flex items-center gap-1.5 border-l-2 ${colorScheme.border} my-0.5 py-0.5 pl-3`}>
        <span className="flex-shrink-0 text-xs text-muted-foreground">{label || toolName}</span>
        <span className="text-[10px] text-muted-foreground/40">/</span>
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className={`min-w-0 truncate font-mono text-xs ${colorScheme.primary}`}>
            {value}
          </span>
          {completionTime}
        </span>
        {secondary && (
          <span className="flex-shrink-0 text-[11px] italic text-muted-foreground/60">
            {secondary}
          </span>
        )}
        {status && <ToolStatusBadge status={status} />}
        {toolResult && (
          <a
            href={`#tool-result-${toolId}`}
            className="flex flex-shrink-0 items-center gap-0.5 text-[11px] text-primary transition-colors hover:text-primary/80"
          >
            <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </a>
        )}
      </div>
    );
  }

  // Default one-line style
  return (
    <div className={`group flex items-center gap-1.5 ${colorScheme.background || ''} border-l-2 ${colorScheme.border} my-0.5 py-0.5 pl-3`}>
      {icon && (
        <span className={`${colorScheme.icon} flex-shrink-0 text-xs`}>{icon}</span>
      )}
      {!icon && (label || toolName) && (
        <span className="flex-shrink-0 text-xs text-muted-foreground">{label || toolName}</span>
      )}
      {(icon || label || toolName) && (
        <span className="text-[10px] text-muted-foreground/40">/</span>
      )}
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className={`min-w-0 font-mono text-xs ${wrapText ? 'whitespace-pre-wrap break-all' : 'truncate'} ${colorScheme.primary}`}>
          {value}
        </span>
        {completionTime}
      </span>
      {secondary && (
        <span className={`text-[11px] ${colorScheme.secondary} flex-shrink-0 italic`}>
          {secondary}
        </span>
      )}
      {status && <ToolStatusBadge status={status} />}
      {action === 'copy' && renderCopyButton()}
    </div>
  );
};
