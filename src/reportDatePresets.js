import dayjs from 'dayjs';

export const reportDateOptions = [
  { value: 'monthToDate', label: '本月至今' },
  { value: 'yesterday', label: '昨天' },
  { value: 'last7', label: '过去 7 天' },
  { value: 'lastMonth', label: '过去 1 个月' },
  { value: 'last3Months', label: '过去 3 个月' },
  { value: 'lastYear', label: '过去 1 年' },
  { value: 'custom', label: '自定义' }
];

// Rolling comparisons use complete days; the existing default keeps today's live data.
export function reportPresetRange(preset, now = dayjs()) {
  const today = dayjs(now).startOf('day');
  if (preset === 'monthToDate') return [today.startOf('month'), today];
  const end = today.subtract(1, 'day');
  const start = preset === 'yesterday' ? end
    : preset === 'last7' ? end.subtract(6, 'day')
    : preset === 'lastMonth' ? end.add(1, 'day').subtract(1, 'month')
    : preset === 'last3Months' ? end.add(1, 'day').subtract(3, 'month')
    : preset === 'lastYear' ? end.add(1, 'day').subtract(1, 'year')
    : null;
  return start ? [start, end] : null;
}

export function selectedReportPreset(range, now = dayjs()) {
  if (!range?.[0] || !range?.[1]) return 'all';
  const start = range[0].format('YYYY-MM-DD');
  const end = range[1].format('YYYY-MM-DD');
  return reportDateOptions.find(({ value }) => {
    const preset = reportPresetRange(value, now);
    return preset && preset[0].format('YYYY-MM-DD') === start && preset[1].format('YYYY-MM-DD') === end;
  })?.value || 'custom';
}
