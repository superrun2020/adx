import React from 'react';
import { DatePicker, Select, Space } from 'antd';
import { reportDateOptions, reportPresetRange, selectedReportPreset } from './reportDatePresets.js';

export default function ReportDateFilter({ value, onChange, allowAll = false }) {
  const options = allowAll ? [{ value: 'all', label: '全部日期' }, ...reportDateOptions] : reportDateOptions;
  return <Space wrap size={8}>
    <Select aria-label="快捷日期" style={{ width: 145 }} value={selectedReportPreset(value)} options={options}
      onChange={preset => {
        if (preset === 'all') onChange(null);
        else if (preset !== 'custom') onChange(reportPresetRange(preset));
      }} />
    <DatePicker.RangePicker aria-label="自定义日期范围" value={value} allowClear={allowAll}
      onChange={range => { if (range?.[0] && range?.[1]) onChange(range); else if (allowAll) onChange(null); }} />
  </Space>;
}
