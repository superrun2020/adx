import React, { useEffect, useId, useRef, useState } from 'react';
import useLocale from './useLocale.js';

export default function RevenueChart({ data, formatMoney, metric = 'revenue', label, color, type = 'line' }) {
  const gradientId = useId();
  const locale = useLocale();
  const shortNumber = new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'zh-CN', { notation:'compact', maximumFractionDigits:1 });
  const container = useRef(null);
  const [width, setWidth] = useState(640);
  const [active, setActive] = useState(null);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => setWidth(Math.max(320, element.clientWidth));
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const rows = (data || []).filter(row => row[metric] != null && Number.isFinite(Number(row[metric])))
    .map(row => ({ date: String(row.date || ''), value: Number(row[metric]) }));
  const height = 300, left = 62, right = 18, top = 20, bottom = 36;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const isBar = type === 'bar';
  const stepWidth = plotWidth / Math.max(1, rows.length);
  const barWidth = Math.min(36, stepWidth * 0.72);
  const values = rows.map(row => row.value);
  const minimum = Math.min(0, ...values);
  const maximum = Math.max(metric === 'matchRate' ? 100 : 0, ...values) || (minimum === 0 ? 1 : 0);
  const x = index => left + (isBar ? (index + 0.5) * stepWidth
    : rows.length === 1 ? plotWidth / 2 : index * plotWidth / (rows.length - 1));
  const y = value => top + plotHeight * (maximum - value) / (maximum - minimum);
  const baseline = y(0);
  const line = rows.map((row, index) => (index ? 'L' : 'M') + x(index).toFixed(1) + ' ' + y(row.value).toFixed(1)).join(' ');
  const area = rows.length ? line + ' L ' + x(rows.length - 1).toFixed(1) + ' ' + baseline + ' L ' + x(0).toFixed(1) + ' ' + baseline + ' Z' : '';
  const labels = rows.length < 2 ? [0] : [0, Math.floor((rows.length - 1) / 2), rows.length - 1].filter((value, index, all) => all.indexOf(value) === index);
  const selected = active === null ? null : rows[active];

  return <div ref={container} className="revenue-chart" style={color ? {"--report-accent":color} : undefined}>
    {rows.length ? <>
      <svg width="100%" height="100%" viewBox={'0 0 ' + width + ' ' + height} role="img" aria-label={label || '每日收益趋势'} data-chart-type={type}
        onPointerMove={event => {
          const bounds = event.currentTarget.getBoundingClientRect();
          const localX = (event.clientX - bounds.left) * width / bounds.width;
          const index = isBar ? Math.floor((localX - left) / stepWidth)
            : Math.round((localX - left) * (rows.length - 1) / plotWidth);
          setActive(Math.max(0, Math.min(rows.length - 1, index)));
        }} onPointerLeave={() => setActive(null)}>
        {!isBar && <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--report-accent)" stopOpacity=".23"/><stop offset="100%" stopColor="var(--report-accent)" stopOpacity="0"/></linearGradient></defs>}
        {[0, 1, 2, 3, 4].map(step => {
          const value = minimum + (maximum - minimum) * step / 4;
          const position = y(value);
          return <g key={step}><line x1={left} x2={width - right} y1={position} y2={position} stroke="var(--report-grid)" strokeDasharray="3 3"/><text x={left - 10} y={position + 4} textAnchor="end" fill="var(--report-muted)" fontSize="11">{metric === 'matchRate' || metric === 'clickRate' ? value.toFixed(1) + '%' : shortNumber.format(value)}</text></g>;
        })}
        {labels.map(index => <text key={index} x={x(index)} y={height - 10} textAnchor={rows.length === 1 ? 'middle' : index === 0 ? 'start' : index === rows.length - 1 ? 'end' : 'middle'} fill="var(--report-muted)" fontSize="11">{rows[index].date.slice(5)}</text>)}
        {isBar ? rows.map((row, index) => <rect key={row.date} x={x(index) - barWidth / 2} width={barWidth}
          y={Math.min(baseline, y(row.value))} height={Math.abs(baseline - y(row.value))}
          rx={Math.min(3,barWidth/2)} fill="var(--report-accent)" opacity={active === index ? 1 : 0.78}/>) : <>
          <path d={area} fill={"url(#" + gradientId + ")"}/><path d={line} fill="none" stroke="var(--report-accent)" strokeWidth="2.5" strokeLinejoin="round"/>
          {selected && <line x1={x(active)} x2={x(active)} y1={top} y2={top + plotHeight} stroke="var(--report-focus)" strokeDasharray="4 4"/>}
          {(selected || rows.length === 1) && <circle cx={x(selected ? active : 0)} cy={y((selected || rows[0]).value)} r="5" fill="var(--report-accent)" stroke="#fff" strokeWidth="2"/>}
        </>}
      </svg>
      {selected && <div className="revenue-tooltip" style={{ left: Math.min(width - 162, Math.max(8, x(active) - 66)), top: Math.max(0, y(selected.value) - 56) }}><span>{selected.date}</span><strong>{label && <span>{label} </span>}{formatMoney(selected.value)}</strong></div>}
    </> : <div className="revenue-empty">所选区间暂无数据</div>}
  </div>;
}
