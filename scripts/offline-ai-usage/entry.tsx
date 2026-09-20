import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import AiUsagePanel from '../../src/components/ai-usage/AiUsagePanel';
import Overlay from '../../src/components/ai-usage/ReportOverlay';
import reportChinese from '../../src/i18n/locales/zh-CN/aiUsage.json';
import { selectOfflineUser } from './client';
import '../../src/index.css';

const i18n = i18next.createInstance();
void i18n.use(initReactI18next).init({ lng: 'zh-CN', fallbackLng: 'zh-CN', initImmediate: false,
  interpolation: { escapeValue: false }, resources: { 'zh-CN': { aiUsage: {
    ...reportChinese,
    nonRealtime: '离线模拟 · 固定数据快照',
    nextRun: '自动更新', notScheduled: '离线版不自动更新',
    todayHint: '模拟数据截至 2026-09-12。筛选在浏览器内计算，无需网络；刷新不会产生新数据。',
    noBatchHint: '这是用于演示空状态的租户，请切回“示例租户”查看模拟报表。',
    exportUnconfigured: '离线演示不运行异步导出服务。页面和模拟数据已完整包含在本 HTML 文件中，可直接复制分享。',
    refreshConfirmMessage: '刷新将重新查询本地模拟数据，不连接服务器，也不会生成新数据。是否继续？',
    partialHint: '模拟场景包含未完成请求或未覆盖来源；未知值显示 —，不是 0。此离线快照不会自动补齐数据。',
  } } } });

function downloadAttachment(kind: 'definitions' | 'source') {
  const data = JSON.parse(document.getElementById('offline-package')!.textContent!);
  const blob = kind === 'source'
    ? new Blob([Uint8Array.from(atob(data.sourceZip), char => char.charCodeAt(0))], { type: 'application/zip' })
    : new Blob([data.definitions], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = kind === 'source' ? 'AI看板-附带源码与许可.zip' : 'AI看板-统计口径说明.md';
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function OfflinePreview() {
  const [tenantId, setTenantId] = useState(10);
  const [userId, setUserId] = useState(2);
  const [dark, setDark] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  return <I18nextProvider i18n={i18n}>
    <div className="min-h-screen bg-background text-foreground">
      <header style={{ position: 'sticky', top: 0, zIndex: 30, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, padding: '12px 20px', background: '#fff7ed', color: '#9a3412', borderBottom: '1px solid #fed7aa', fontSize: 13 }}>
        <strong>离线演示 · 仅模拟数据 · 非真实业务报表</strong>
        <span>3,556 条模拟业务数据 · 无需网络或服务器</span>
        <select aria-label="预览租户" value={tenantId} onChange={(event) => setTenantId(Number(event.target.value))} style={{ padding: 6, borderRadius: 6 }}>
          <option value={10}>示例租户（已发布）</option><option value={20}>空租户（尚未统计）</option>
        </select>
        <select aria-label="预览身份" value={userId} onChange={(event) => { const id = Number(event.target.value); selectOfflineUser(id); setUserId(id); }} style={{ padding: 6, borderRadius: 6 }}>
          <option value={2}>租户管理员</option><option value={3}>普通用户</option>
        </select>
        <button onClick={() => { document.documentElement.classList.toggle('dark', !dark); setDark(!dark); }} style={{ padding: 6, border: '1px solid #fdba74', borderRadius: 6 }}>{dark ? '浅色' : '深色'}</button>
        <button onClick={() => setHelpOpen(true)} style={{ padding: 6, border: '1px solid #fdba74', borderRadius: 6 }}>离线说明</button>
      </header>
      <AiUsagePanel key={`${tenantId}:${userId}`} tenantId={tenantId} />
      {helpOpen && <Overlay title="单文件离线说明" onClose={() => setHelpOpen(false)} compact>
        <div className="space-y-4 text-sm leading-6">
          <p>只需复制这一个 HTML 文件到另一台电脑，用 Chrome、Edge、Firefox 或 Safari 打开。无需安装 Node.js 或数据库，也无需联网或启动服务。</p>
          <p>包含当前六个报表页签。筛选、分组、Hook 字段统计和 CSV 导出均在本机执行；导出覆盖全部匹配结果，不限当前页。</p>
          <p>仅为固定模拟快照，数据截至 2026-09-12，不连接真实业务库、不会夜间自动更新。代码生成量仅来自 SQL 行数；CodeHub 提交量仍是演示数据。</p>
          <p>统计口径、相关源码及许可也内嵌在本文件中，可按需另存；它们不是运行所需的外部文件。</p>
          <div className="flex flex-wrap gap-3">
            <button className="rounded-md border px-3 py-2" onClick={() => downloadAttachment('definitions')}>下载统计口径</button>
            <button className="rounded-md border px-3 py-2" onClick={() => downloadAttachment('source')}>下载源码与许可</button>
          </div>
        </div>
      </Overlay>}
    </div>
  </I18nextProvider>;
}

createRoot(document.getElementById('root')!).render(<OfflinePreview />);
