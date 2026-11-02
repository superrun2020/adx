import { gamApiRequest } from './gam-beta.mjs';

export const REPORT_DIMENSIONS = ['DATE', 'HOUR', 'SITE', 'COUNTRY_CODE', 'AD_UNIT_NAME'];
export const REPORT_METRICS = [
  'AD_EXCHANGE_TOTAL_REQUESTS', 'AD_EXCHANGE_RESPONSES_SERVED',
  'AD_EXCHANGE_IMPRESSIONS', 'AD_EXCHANGE_CLICKS', 'AD_EXCHANGE_REVENUE'
];
const REPORT_NAME = /^networks\/(\d+)\/reports\/(\d+)$/;
const RESULT_NAME = /^networks\/(\d+)\/reports\/(\d+)\/results\/(\d+)$/;
const OPERATION_NAME = /^networks\/(\d+)\/operations\/reports\/runs\/(\d+)$/;

function dateObject(isoDate) {
  const parsed = new Date(String(isoDate) + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(isoDate)) ||
      Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== isoDate) {
    throw new Error('invalid_report_date');
  }
  const [year, month, day] = isoDate.split('-').map(Number);
  return { year, month, day };
}

export function buildReportDefinition(start, end) {
  const startDate = dateObject(start), endDate = dateObject(end);
  if (start > end || Date.parse(end) - Date.parse(start) > 31 * 86400000) throw new Error('invalid_report_range');
  return {
    dimensions: REPORT_DIMENSIONS,
    metrics: REPORT_METRICS,
    timeZoneSource: 'PUBLISHER',
    currencyCode: 'USD',
    dateRange: { fixed: { startDate, endDate } },
    reportType: 'HISTORICAL'
  };
}

export function validateReportDefinition(report, network) {
  if (!REPORT_NAME.test(String(report?.name || '')) || REPORT_NAME.exec(report.name)[1] !== String(network)) {
    throw new Error('invalid_rest_report_name');
  }
  const definition = report.reportDefinition || {};
  if (JSON.stringify(definition.dimensions) !== JSON.stringify(REPORT_DIMENSIONS) ||
      JSON.stringify(definition.metrics) !== JSON.stringify(REPORT_METRICS) ||
      definition.reportType !== 'HISTORICAL' || definition.currencyCode !== 'USD' ||
      definition.comparisonDateRange || definition.timePeriodColumn ||
      definition.timeZoneSource !== 'PUBLISHER') {
    throw new Error('rest_report_definition_mismatch');
  }
  return definition;
}

export async function createRestReport(network, token, start, end, fetchImpl) {
  const report = await gamApiRequest(network, token, 'networks/' + network + '/reports', {
    method: 'POST', fetchImpl,
    body: {
      displayName: 'AdX Control REST sync ' + network,
      visibility: 'HIDDEN',
      reportDefinition: buildReportDefinition(start, end)
    }
  });
  validateReportDefinition(report, network);
  return report;
}

export async function setReportRange(network, token, reportName, start, end, fetchImpl) {
  if (!REPORT_NAME.test(reportName) || REPORT_NAME.exec(reportName)[1] !== String(network)) throw new Error('invalid_rest_report_name');
  const report = await gamApiRequest(network, token, reportName, {
    method: 'PATCH', query: { updateMask: 'reportDefinition.dateRange' }, fetchImpl,
    body: { name: reportName, reportDefinition: { dateRange: buildReportDefinition(start, end).dateRange } }
  });
  validateReportDefinition(report, network);
  return report;
}

export async function fetchRestReport(network, token, reportName, { fetchImpl, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (!REPORT_NAME.test(reportName) || REPORT_NAME.exec(reportName)[1] !== String(network)) throw new Error('invalid_rest_report_name');
  let operation = await gamApiRequest(network, token, reportName + ':run', { method: 'POST', fetchImpl });
  if (!OPERATION_NAME.test(String(operation?.name || '')) || OPERATION_NAME.exec(operation.name)[1] !== String(network)) {
    throw new Error('invalid_rest_report_operation');
  }
  for (let attempt = 0; !operation.done && attempt < 60; attempt += 1) {
    await sleep(Math.min(30000, 5000 * 1.4 ** attempt));
    operation = await gamApiRequest(network, token, operation.name, { fetchImpl });
  }
  if (!operation.done) throw new Error('rest_report_timeout');
  if (operation.error) throw new Error('rest_report_failed: ' + String(operation.error.message || 'unknown').slice(0, 400));
  const resultName = operation.response?.reportResult;
  if (!RESULT_NAME.test(String(resultName || '')) || RESULT_NAME.exec(resultName)[1] !== String(network)) {
    throw new Error('invalid_rest_report_result');
  }
  const rows = [];
  const seen = new Set();
  let pageToken = '';
  let dateRanges;
  do {
    const page = await gamApiRequest(network, token, resultName + ':fetchRows', {
      query: { pageSize: 10000, pageToken }, fetchImpl
    });
    if (!dateRanges) dateRanges = page.dateRanges;
    rows.push(...(page.rows || []));
    if (rows.length > 200000) throw new Error('rest_report_too_large');
    pageToken = page.nextPageToken || '';
    if (pageToken && seen.has(pageToken)) throw new Error('rest_report_repeated_page');
    if (pageToken) seen.add(pageToken);
  } while (pageToken);
  if (!Array.isArray(dateRanges) || dateRanges.length !== 1) throw new Error('rest_report_date_ranges_mismatch');
  return { rows, dateRanges, resultName };
}

function scalar(value) {
  if (value && Object.hasOwn(value, 'intValue')) return value.intValue;
  if (value && Object.hasOwn(value, 'doubleValue')) return value.doubleValue;
  if (value && Object.hasOwn(value, 'stringValue')) return value.stringValue;
  throw new Error('missing_rest_report_value');
}

function integer(value) {
  const number = Number(scalar(value));
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('invalid_rest_report_integer');
  return number;
}

function reportDate(value) {
  const raw = String(scalar(value));
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  const iso = compact ? compact[1] + '-' + compact[2] + '-' + compact[3] : raw;
  dateObject(iso);
  return iso;
}

export function normalizeRestReportRows(rows, { channelId, accountKey, sourceFile, moneyDivisor }) {
  if (!Number.isSafeInteger(channelId) || channelId < 1 || !accountKey || ![1, 1000000].includes(moneyDivisor)) {
    throw new Error('invalid_rest_report_mapping');
  }
  return rows.map(row => {
    const dimensions = row.dimensionValues || [];
    const metrics = row.metricValueGroups?.[0]?.primaryValues || [];
    if (dimensions.length !== REPORT_DIMENSIONS.length || row.metricValueGroups?.length !== 1 ||
        metrics.length !== REPORT_METRICS.length) throw new Error('rest_report_columns_mismatch');
    const date = reportDate(dimensions[0]);
    const hour = integer(dimensions[1]);
    if (hour > 23) throw new Error('invalid_rest_report_hour');
    const url = String(scalar(dimensions[2]) || '').trim();
    const country = String(scalar(dimensions[3]) || '').trim();
    const adUnit = String(scalar(dimensions[4]) || '').trim();
    const revenueRaw = Number(scalar(metrics[4]));
    if (!Number.isFinite(revenueRaw)) throw new Error('invalid_rest_report_revenue');
    return {
      channelId, reportDate: date, hour, url, account: accountKey, adUnit, country,
      requests: integer(metrics[0]), matched: integer(metrics[1]),
      impressions: integer(metrics[2]), clicks: integer(metrics[3]),
      revenue: revenueRaw / moneyDivisor, sourceFile, rawJson: JSON.stringify(row)
    };
  });
}
