import React from 'react';
import { Table } from 'antd';

function fitColumns(columns) {
  const weights = columns.map(column => {
    if (column.children) return 2;
    const width = Number.parseFloat(column.width);
    if (typeof column.width === 'string' && column.width.endsWith('%')) return width * 15;
    if (Number.isFinite(width)) return Math.max(width, 60);
    return column.align === 'right' ? 110 : 160;
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return columns.map((column, index) => ({
    ...column,
    fixed: undefined,
    ellipsis: false,
    width: (weights[index] / total * 100) + '%',
    ...(column.children ? { children: fitColumns(column.children) } : {})
  }));
}

export default function FitTable({ columns = [], scroll, className = '', ...props }) {
  const verticalScroll = scroll?.y ? { y: scroll.y } : undefined;
  return <Table {...props} columns={fitColumns(columns)} scroll={verticalScroll}
    tableLayout="fixed" className={['fit-data-table', className].filter(Boolean).join(' ')}/>;
}
