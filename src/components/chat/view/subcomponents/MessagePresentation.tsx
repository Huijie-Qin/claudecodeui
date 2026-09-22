import type { ReactNode } from 'react';
import { Bot } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';

import { Markdown } from './Markdown';
import MessageCopyControl from './MessageCopyControl';

/** Shared presentation only: execution, permissions and streaming stay with the caller. */
export function UserMessageBubble({ content, grouped, state = 'sent', attachments, footer }: {
  content: ReactNode; grouped?: boolean; state?: 'sent' | 'queued' | 'failed'; attachments?: ReactNode; footer?: ReactNode;
}) {
  return <div className="flex w-full items-end space-x-0 sm:w-auto sm:max-w-[85%] sm:space-x-3 md:max-w-md lg:max-w-lg xl:max-w-xl">
    <div className={`group min-w-0 flex-1 rounded-2xl rounded-br-md px-3 py-2 text-white shadow-sm sm:flex-initial sm:px-4 ${state === 'queued'
      ? 'border border-dashed border-blue-300/80 bg-blue-600/75'
      : state === 'failed' ? 'border border-red-300/80 bg-red-600/85' : 'bg-blue-600'}`}>
      <div className="whitespace-pre-wrap break-words text-sm">{content}</div>
      {attachments}{footer}
    </div>
    {!grouped && <div className="hidden h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-blue-600 text-sm text-white sm:flex">U</div>}
  </div>;
}

export function MessageHeader({ type = 'assistant', provider, label }: { type?: string; provider?: string; label?: string }) {
  const { t } = useTranslation('chat');
  const name = label || (type === 'error' ? t('messageTypes.error') : type === 'tool' ? t('messageTypes.tool')
    : t(`messageTypes.${['cursor', 'codex', 'gemini'].includes(provider || '') ? provider : 'claude'}`));
  return <div className="mb-2 flex items-center space-x-3">
    {type === 'error' ? <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-red-600 text-sm text-white">!</div>
      : type === 'tool' ? <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-gray-600 text-sm text-white dark:bg-gray-700">🔧</div>
        : <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full p-1 text-sm text-white">
          {provider ? <SessionProviderLogo provider={provider} className="h-full w-full" /> : <Bot className="h-6 w-6 text-muted-foreground" />}
        </div>}
    <div className="text-sm font-medium text-gray-900 dark:text-white">{name}</div>
  </div>;
}

export function MessageFooter({ role = 'assistant', content, time, children, actions }: {
  role?: 'user' | 'assistant'; content?: string; time?: string; children?: ReactNode; actions?: ReactNode;
}) {
  return <div className={role === 'user' ? 'mt-1 flex items-center justify-end gap-1 text-xs text-blue-100'
    : 'mt-1 flex w-full items-center gap-2 text-[11px] text-gray-400 dark:text-gray-500'}>
    {children}{content && <MessageCopyControl content={content} messageType={role} />}{actions}{time && <span>{time}</span>}
  </div>;
}

export function MessageBody({ content, markdown = true, onFileOpen }: { content: string; markdown?: boolean; onFileOpen?: (filePath: string) => void }) {
  const { t } = useTranslation('chat');
  const trimmed = content.trim();
  if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && (trimmed.endsWith('}') || trimmed.endsWith(']'))) {
    try {
      const formatted = JSON.stringify(JSON.parse(trimmed), null, 2);
      return <div className="my-2">
        <div className="mb-2 flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>
          <span className="font-medium">{t('json.response')}</span>
        </div>
        <div className="overflow-hidden rounded-lg border border-gray-600/30 bg-gray-800 dark:border-gray-700 dark:bg-gray-900">
          <pre className="overflow-x-auto p-4"><code className="block whitespace-pre font-mono text-sm text-gray-100 dark:text-gray-200">{formatted}</code></pre>
        </div>
      </div>;
    } catch { /* Render non-JSON as normal message text. */ }
  }
  return markdown ? <Markdown onFileOpen={onFileOpen} className="prose prose-sm prose-gray max-w-none dark:prose-invert">{content}</Markdown>
    : <div className="whitespace-pre-wrap">{content}</div>;
}
