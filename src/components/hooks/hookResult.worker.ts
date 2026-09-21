import { createResultPager } from './hookResultPages';

self.onmessage = ({ data }: MessageEvent) => {
  try {
    if (data.type !== 'init') return;
    let display = data.value;
    // Parsing/formatting of text-wrapped MCP JSON stays off the UI thread.
    if (typeof display === 'string') {
      try { display = JSON.parse(display); } catch { /* Preview plain text as-is. */ }
    }
    self.postMessage({ type: 'preview', ...createResultPager(display)(0) });
  } catch {
    self.postMessage({ type: 'error' });
  }
};
