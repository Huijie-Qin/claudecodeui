import { useEffect, useRef, useState } from 'react';

export type TrendSeries = { key: string; label: string; secondary?: boolean };
export type TrendDatum = { date: string; [key: string]: number | string | null };

/** One scale, real values, no minimum-height bars for zero/missing measurements. */
export default function ReportTrend({ rows, series, unit, label, line = false }: {
  rows: TrendDatum[]; series: TrendSeries[]; unit: string; label: string; line?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(760);
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(240, entry.contentRect.width)));
    observer.observe(host);
    return () => observer.disconnect();
  }, []);
  const height = 216, left = 48, right = 18, top = 25, bottom = 37;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const values = rows.flatMap(row => series.map(s => row[s.key]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v)));
  const highest = Math.max(1, ...values);
  const magnitude = 10 ** Math.floor(Math.log10(highest));
  const max = Math.ceil(highest / magnitude) * magnitude;
  const dates = rows.map(row => Date.parse(`${row.date}T00:00:00Z`));
  const start = Math.min(...dates), end = Math.max(...dates);
  const slots = Math.max(1, (end - start) / 86400000 + 1);
  const slotWidth = plotWidth / slots;
  const x = (i: number) => left + (slots === 1 ? plotWidth / 2 : ((dates[i] - start) / 86400000 + .5) * slotWidth);
  const y = (value: number) => top + plotHeight * (1 - value / max);
  const bar = Math.min(25, slotWidth / (series.length + 1));
  const tickEvery = Math.max(1, Math.ceil(rows.length / Math.max(2, Math.floor(plotWidth / 65))));
  const number = (v: number) => v >= 1000 ? `${Number((v / 1000).toFixed(1))}k` : Number(v.toFixed(1)).toLocaleString();
  return <div ref={ref} className="ai-report-chart">
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
      <title>{label}</title><text x={left} y={13}>{unit}</text>
      {[0, .5, 1].map(fraction => <g key={fraction}><line x1={left} x2={width - right} y1={y(max * fraction)} y2={y(max * fraction)} className="ai-chart-grid" /><text x={left - 9} y={y(max * fraction) + 4} textAnchor="end">{number(max * fraction)}</text></g>)}
      {rows.map((row, i) => (i % tickEvery === 0 || (i === rows.length - 1 && i % tickEvery > tickEvery / 2)) && <text key={row.date} x={x(i)} y={height - 13} textAnchor="middle">{row.date.slice(5).replace('-', '/')}</text>)}
      {series.map(s => {
        const color = s.secondary ? 'var(--ai-report-series-light)' : 'var(--ai-report-accent)';
        let path = '', connected = false;
        if (line) rows.forEach((row, i) => {
          const value = row[s.key];
          if (typeof value !== 'number' || !Number.isFinite(value)) { connected = false; return; }
          path += `${connected ? 'L' : 'M'}${x(i)},${y(value)} `; connected = true;
        });
        return <g key={s.key}>
          {line && <path d={path} fill="none" stroke={color} strokeWidth={2.5} />}
          {rows.map((row, i) => {
            const value = row[s.key];
            if (typeof value !== 'number' || !Number.isFinite(value)) return null;
            const tooltip = `${row.date} · ${s.label}: ${Number(value.toFixed(2)).toLocaleString()} ${unit}`;
            return line ? <circle key={row.date} cx={x(i)} cy={y(value)} r={3} fill={color} tabIndex={0} aria-label={tooltip}><title>{tooltip}</title></circle>
              : <rect key={row.date} x={x(i) - bar * series.length / 2 + series.indexOf(s) * bar} y={y(value)} width={Math.max(1, bar - 2)} height={Math.max(0, y(0) - y(value))} rx={2} fill={color} tabIndex={0} aria-label={tooltip}><title>{tooltip}</title></rect>;
          })}
        </g>;
      })}
    </svg>
  </div>;
}
