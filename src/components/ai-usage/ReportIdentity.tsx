import { Boxes, Code2, FileText, UserRound, Webhook } from 'lucide-react';

export default function ReportIdentity({ name, kind = 'user', subtitle }: { name: string; kind?: string; subtitle?: string }) {
  const Icon = kind === 'workspace' ? Boxes : kind === 'hook' ? Webhook : kind === 'skill' ? Code2 : kind === 'template' ? FileText : UserRound;
  return <span className="ai-report-identity"><span className={`ai-report-avatar ${kind === 'user' || kind === 'publisher' ? '' : 'square'}`} aria-hidden="true"><Icon className="h-3.5 w-3.5" /></span><span>{name}{subtitle && <small>{subtitle}</small>}</span></span>;
}
