import React, { useMemo, useState } from 'react';

import { copyTextToClipboard } from '../../../../utils/clipboard';
import type { ToolResult } from '../../types/types';
import { normalizeBashOutput } from '../utils/bashOutput';

interface BashOutputContentProps {
  toolResult?: ToolResult | null;
}

export const BashOutputContent: React.FC<BashOutputContentProps> = ({ toolResult }) => {
  const [copied, setCopied] = useState(false);
  const output = useMemo(() => normalizeBashOutput(toolResult), [toolResult]);

  if (!output.hasOutput) {
    return null;
  }

  const copyContent = [output.stdout, output.stderr].filter(Boolean).join('\n');

  const handleCopy = async () => {
    const didCopy = await copyTextToClipboard(copyContent);
    if (!didCopy) return;

    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="mt-1.5">
      <div className="group flex items-start gap-2">
        <div className="flex flex-shrink-0 items-center gap-1.5 pt-1.5">
          <svg className="h-3 w-3 text-green-500 dark:text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
        </div>

        <div className="flex min-w-0 flex-1 items-start gap-2">
          <div className="max-h-96 w-fit min-w-0 max-w-full overflow-auto rounded bg-gray-900 dark:bg-black">
            {output.stdout && (
              <pre className="m-0 whitespace-pre-wrap break-words px-2.5 py-1 font-mono text-xs leading-5 text-green-400">
                {output.stdout}
              </pre>
            )}
            {output.stderr && (
              <pre className={`m-0 whitespace-pre-wrap break-words px-2.5 py-1 font-mono text-xs leading-5 text-red-400 ${output.stdout ? 'border-t border-gray-700 dark:border-gray-800' : ''}`}>
                {output.stderr}
              </pre>
            )}
          </div>

          <button
            type="button"
            onClick={handleCopy}
            className="mt-1.5 flex-shrink-0 text-muted-foreground/40 opacity-0 transition-all hover:text-muted-foreground group-hover:opacity-100"
            aria-label="Copy command output"
            title="Copy command output"
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
        </div>
      </div>
    </div>
  );
};
