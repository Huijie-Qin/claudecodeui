import { parse } from 'yaml';
import { useMemo } from 'react';
import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import MarkdownCodeBlock from './MarkdownCodeBlock';

type MarkdownPreviewProps = {
  content: string;
};

type ParsedFrontMatter = {
  frontMatter: Record<string, unknown> | null;
  body: string;
};

function extractFrontMatter(content: string): ParsedFrontMatter {
  if (!content.startsWith('---')) {
    return { frontMatter: null, body: content };
  }

  const frontMatterMatch = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!frontMatterMatch) {
    return { frontMatter: null, body: content };
  }

  const frontMatterBody = frontMatterMatch[1].trim();
  const rest = content.slice(frontMatterMatch[0].length);

  if (!frontMatterBody) {
    return { frontMatter: null, body: rest };
  }

  try {
    const parsed = parse(frontMatterBody);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { frontMatter: null, body: content };
    }

    return { frontMatter: parsed as Record<string, unknown>, body: rest };
  } catch {
    return { frontMatter: null, body: content };
  }
}

function formatFrontMatterValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'boolean' || typeof value === 'number') {
    return String(value);
  }

  if (typeof value === 'string') {
    return value;
  }

  return JSON.stringify(value);
}

function FrontMatterTable({ frontMatter }: { frontMatter: Record<string, unknown> }) {
  const entries = Object.entries(frontMatter);

  if (entries.length === 0) {
    return null;
  }

  return (
    <table className="mb-4 w-full border-collapse border border-gray-200 text-sm dark:border-gray-700">
      <tbody>
        {entries
          .filter(([key]) => typeof key === 'string' && key.length > 0)
          .map(([key, value]) => (
            <tr key={key}>
              <td className="w-1/3 border border-gray-200 bg-gray-50 px-3 py-2 font-semibold text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100">
                {key}
              </td>
              <td className="border border-gray-200 px-3 py-2 text-gray-900 dark:border-gray-700 dark:text-gray-200">
                <span className="whitespace-pre-wrap">{formatFrontMatterValue(value)}</span>
              </td>
            </tr>
          ))}
      </tbody>
    </table>
  );
}

const markdownPreviewComponents: Components = {
  code: MarkdownCodeBlock,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-4 border-gray-300 pl-4 italic text-gray-600 dark:border-gray-600 dark:text-gray-400">
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => (
    <a href={href} className="text-blue-600 hover:underline dark:text-blue-400" target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="min-w-full border-collapse border border-gray-200 dark:border-gray-700">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-gray-50 dark:bg-gray-800">{children}</thead>,
  th: ({ children }) => (
    <th className="border border-gray-200 px-3 py-2 text-left text-sm font-semibold dark:border-gray-700">{children}</th>
  ),
  td: ({ children }) => (
    <td className="border border-gray-200 px-3 py-2 align-top text-sm dark:border-gray-700">{children}</td>
  ),
};

const remarkGfmOptions = { singleTilde: false };
const remarkGfmPlugin: [typeof remarkGfm, typeof remarkGfmOptions] = [remarkGfm, remarkGfmOptions];

export default function MarkdownPreview({ content }: MarkdownPreviewProps) {
  const remarkPlugins = useMemo(() => [remarkGfmPlugin, remarkMath], []);
  const rehypePlugins = useMemo(() => [rehypeKatex], []);
  const parsed = useMemo(() => extractFrontMatter(content), [content]);

  return (
    <>
      {parsed.frontMatter ? <FrontMatterTable frontMatter={parsed.frontMatter} /> : null}
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={markdownPreviewComponents}
      >
        {parsed.frontMatter ? parsed.body : content}
      </ReactMarkdown>
    </>
  );
}
