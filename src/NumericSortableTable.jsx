import React, { useState } from 'react';
import { Table } from 'antd';
import NumericSortHeader from './NumericSortHeader.jsx';

function numericValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = Number(String(value ?? '').replace(/[$,%\s]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

export default function NumericSortableTable({ columns, dataSource = [], numericKeys, ...props }) {
  const [sort, setSort] = useState(null);
  const keys = new Set(numericKeys);
  const sortableColumns = columns.map(column => keys.has(column.dataIndex) ? {
    ...column,
    title: <NumericSortHeader label={column.title}
      direction={sort?.key === column.dataIndex ? sort.direction : ''}
      onSort={direction => setSort({ key: column.dataIndex, direction })}/>
  } : column);
  const sorted = sort ? [...dataSource].sort((a, b) => {
    const delta = numericValue(a[sort.key]) - numericValue(b[sort.key]);
    return sort.direction === 'asc' ? delta : -delta;
  }) : dataSource;
  return <Table key={sort ? sort.key + sort.direction : 'default'} {...props}
    columns={sortableColumns} dataSource={sorted}/>;
}
