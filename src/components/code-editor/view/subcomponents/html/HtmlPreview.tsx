import { useMemo } from 'react';

type HtmlPreviewProps = {
  content: string;
  title: string;
};

function removeScriptsFromHtml(content: string) {
  if (typeof DOMParser === 'undefined') {
    return content.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  }

  const document = new DOMParser().parseFromString(content, 'text/html');
  document.querySelectorAll('script').forEach((script) => script.remove());

  return `<!doctype html>\n${document.documentElement.outerHTML}`;
}

export default function HtmlPreview({ content, title }: HtmlPreviewProps) {
  const srcDoc = useMemo(() => removeScriptsFromHtml(content), [content]);

  return (
    <iframe
      title={title}
      srcDoc={srcDoc}
      sandbox="allow-forms allow-modals allow-popups"
      className="h-full w-full border-0 bg-white"
    />
  );
}
