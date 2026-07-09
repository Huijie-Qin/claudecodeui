type HtmlPreviewProps = {
  content: string;
  title: string;
};

export default function HtmlPreview({ content, title }: HtmlPreviewProps) {
  return (
    <iframe
      title={title}
      srcDoc={content}
      sandbox="allow-forms allow-modals allow-popups allow-scripts"
      className="h-full w-full border-0 bg-white"
    />
  );
}
