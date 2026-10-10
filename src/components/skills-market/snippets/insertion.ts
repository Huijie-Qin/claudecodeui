export function snippetInsertion(content: string, from: number, to: number, markdown: string) {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > content.length) {
    throw new Error('编辑选区已失效，请重新选择插入位置。');
  }
  const frontmatter = /^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(content);
  const hasUnclosedHeader = !frontmatter && /^\uFEFF?---[ \t]*\r?\n/.test(content);
  if (hasUnclosedHeader) throw new Error('文件头部的 frontmatter 尚未闭合，请先补全后再插入。');
  const append = Boolean(frontmatter && from < frontmatter[0].length);
  const start = append ? content.length : from;
  const end = append ? content.length : to;
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const insert = `${append && content && !content.endsWith('\n') ? newline : ''}${append ? newline : ''}${markdown}`;
  return { from: start, to: end, insert, anchor: start + insert.length };
}
