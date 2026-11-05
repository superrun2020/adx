import React, { useEffect, useRef, useState } from 'react';

const shortNumber = value => new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value);

export default function RevenueChart({ data, formatMoney }) {
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

  const rows = (data || []).map(row => ({ date: String(row.date || ''), revenue: Number(row.revenue) || 0 }));
  const height = 300, left = 62, right = 18, top = 20, bottom = 36;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const maximum = Math.max(1, ...rows.map(row => row.revenue));
  const x = index => left + (rows.length === 1 ? plotWidth / 2 : index * plotWidth / (rows.length - 1));
  const y = value => top + plotHeight * (1 - value / maximum);
  const baseline = top + plotHeight;
  const line = rows.map((row, index) => (index ? 'L' : 'M') + x(index).toFixed(1) + ' ' + y(row.revenue).toFixed(1)).join(' ');
  const area = rows.length ? line + ' L ' + x(rows.length - 1).toFixed(1) + ' ' + baseline + ' L ' + x(0).toFixed(1) + ' ' + baseline + ' Z' : '';
  const labels = rows.length < 2 ? [0] : [0, Math.floor((rows.length - 1) / 2), rows.length - 1].filter((value, index, all) => all.indexOf(value) === index);
  const selected = active === null ? null : rows[active];

  return <div ref={container} className="revenue-chart">
    {rows.length ? <>
      <svg width="100%" height="100%" viewBox={'0 0 ' + width + ' ' + height} role="img" aria-label="每日收益趋势"
        onMouseMove={event => {
          const bounds = event.currentTarget.getBoundingClientRect();
          const localX = (event.clientX - bounds.left) * width / bounds.width;
          const index = rows.length === 1 ? 0 : Math.round((localX - left) * (rows.length - 1) / plotWidth);
          setActive(Math.max(0, Math.min(rows.length - 1, index)));
        }} onMouseLeave={() => setActive(null)}>
        <defs><linearGradient id="revenue-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#1677ff" stopOpacity=".23"/><stop offset="100%" stopColor="#1677ff" stopOpacity="0"/></linearGradient></defs>
        {[0, 1, 2, 3, 4].map(step => {
          const value = maximum * step / 4;
          const position = y(value);
          return <g key={step}><line x1={left} x2={width - right} y1={position} y2={position} stroke="#e9eef2" strokeDasharray="3 3"/><text x={left - 10} y={position + 4} textAnchor="end" fill="#8294a0" fontSize="11">{shortNumber(value)}</text></g>;
        })}
        {labels.map(index => <text key={index} x={x(index)} y={height - 10} textAnchor={index === 0 ? 'start' : index === rows.length - 1 ? 'end' : 'middle'} fill="#8294a0" fontSize="11">{rows[index].date.slice(5)}</text>)}
        <path d={area} fill="url(#revenue-fill)"/><path d={line} fill="none" stroke="#1677ff" strokeWidth="2.5" strokeLinejoin="round"/>
        {selected && <><line x1={x(active)} x2={x(active)} y1={top} y2={baseline} stroke="#a9c9f7" strokeDasharray="4 4"/><circle cx={x(active)} cy={y(selected.revenue)} r="5" fill="#1677ff" stroke="#fff" strokeWidth="2"/></>}
      </svg>
      {selected && <div className="revenue-tooltip" style={{ left: Math.min(width - 142, Math.max(8, x(active) - 66)), top: Math.max(0, y(selected.revenue) - 56) }}><span>{selected.date}</span><strong>{formatMoney(selected.revenue)}</strong></div>}
    </> : <div className="revenue-empty">所选日期暂无收益数据</div>}
  </div>;
}
