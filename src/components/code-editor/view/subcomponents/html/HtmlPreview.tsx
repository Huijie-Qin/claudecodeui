import { useMemo } from 'react';

type HtmlPreviewProps = {
  content: string;
  title: string;
};

export default function HtmlPreview({ content, title }: HtmlPreviewProps) {
  const srcDoc = useMemo(() => content, [content]);

  return (
    <iframe
      title={title}
      srcDoc={srcDoc}
      sandbox="allow-forms allow-modals allow-popups"
      className="h-full w-full border-0 bg-white"
    />
  );
}
