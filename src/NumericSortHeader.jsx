import React from 'react';
import { CaretDownOutlined, CaretUpOutlined } from '@ant-design/icons';

export default function NumericSortHeader({ label, direction, onSort }) {
  return <span className="numeric-sort-header">
    <span>{label}</span>
    <span className="numeric-sort-actions">
      <button type="button" className={direction === 'asc' ? 'active' : ''}
        aria-label={label + '升序'} title={label + '升序'}
        onClick={event => { event.stopPropagation(); onSort('asc'); }}><CaretUpOutlined /></button>
      <button type="button" className={direction === 'desc' ? 'active' : ''}
        aria-label={label + '降序'} title={label + '降序'}
        onClick={event => { event.stopPropagation(); onSort('desc'); }}><CaretDownOutlined /></button>
    </span>
  </span>;
}
