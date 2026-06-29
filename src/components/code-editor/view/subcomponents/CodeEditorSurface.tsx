import CodeMirror from '@uiw/react-codemirror';
import { oneDark } from '@codemirror/theme-one-dark';
import type { Extension } from '@codemirror/state';
import HtmlPreview from './html/HtmlPreview';
import MarkdownPreview from './markdown/MarkdownPreview';

type CodeEditorPreviewMode = 'markdown' | 'html' | null;

type CodeEditorSurfaceProps = {
  content: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  previewEnabled: boolean;
  previewMode: CodeEditorPreviewMode;
  htmlPreviewTitle: string;
  isDarkMode: boolean;
  fontSize: number;
  showLineNumbers: boolean;
  extensions: Extension[];
};

export default function CodeEditorSurface({
  content,
  onChange,
  readOnly = false,
  previewEnabled,
  previewMode,
  htmlPreviewTitle,
  isDarkMode,
  fontSize,
  showLineNumbers,
  extensions,
}: CodeEditorSurfaceProps) {
  if (previewEnabled && previewMode === 'markdown') {
    return (
      <div className="h-full overflow-y-auto bg-white dark:bg-gray-900">
        <div className="prose prose-sm mx-auto max-w-4xl max-w-none px-8 py-6 dark:prose-invert prose-headings:font-semibold prose-a:text-blue-600 prose-code:text-sm prose-pre:bg-gray-900 prose-img:rounded-lg dark:prose-a:text-blue-400">
          <MarkdownPreview content={content} />
        </div>
      </div>
    );
  }

  if (previewEnabled && previewMode === 'html') {
    return <HtmlPreview content={content} title={htmlPreviewTitle} />;
  }

  return (
    <CodeMirror
      value={content}
      onChange={onChange}
      readOnly={readOnly}
      editable={!readOnly}
      extensions={extensions}
      theme={isDarkMode ? oneDark : undefined}
      height="100%"
      style={{
        fontSize: `${fontSize}px`,
        height: '100%',
      }}
      basicSetup={{
        lineNumbers: showLineNumbers,
        foldGutter: true,
        dropCursor: false,
        allowMultipleSelections: false,
        indentOnInput: true,
        bracketMatching: true,
        closeBrackets: true,
        autocompletion: true,
        highlightSelectionMatches: true,
        searchKeymap: true,
      }}
    />
  );
}
