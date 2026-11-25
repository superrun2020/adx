const storageKey = 'adx_ui_language';
const chinese = /[\u3400-\u9fff]/;
let started = false;
let dictionary = null;
let fragments = null;
let observer;
let loading;
let activeLocale;
const originals = new WeakMap();
const overrides = {
  '请求量':'Requests','点击量':'Clicks',
  '每日流量趋势':'Daily traffic trend','每日投放质量趋势':'Daily delivery quality trend',
  '流量指标':'Traffic metric','质量指标':'Quality metric',
  '图表跟随顶部日期筛选；匹配率＝匹配请求 ÷ 请求量，点击率＝点击量 ÷ 展示量。eCPM 按当前可见收入计算，每千次展示的收入以 USD 计。缺失日期不补零；当天数据尚未完整。':'Charts follow the selected date range. Match rate = matched requests / requests; CTR = clicks / impressions. eCPM uses the revenue visible to your account, in USD per thousand impressions. Missing dates are not filled with zero; today is incomplete.',
  '授权代表手写签名':'Authorized representative signature','待签署':'Awaiting signature',
  '运营工作台':'Operations workspace','渠道主体 / 联系方式':'Publisher / contact',
  '渠道 / 联系方式':'Channel / contact','账号 / 渠道':'Account / channel','统计日期':'Reporting date',
  '域名 / 账号':'Domain / account','对比区间':'Comparison period','收益对比':'Revenue comparison','流量变化':'Traffic change',
  '通知状态':'Notification status','最早确认下修日':'Earliest confirmed rollback date','轮换 API 密钥':'Rotate API key',
  'API 已配置':'API configured','API 未生成':'API not generated','待开通渠道':'Pending channel approval',
  '审核开通后，点击该行的“分配链接”选择对应网站。':'After approval, use Assign website on the same row to select websites.',
  '确认重置':'Reset password','删除渠道':'Delete channel','渠道已删除':'Channel deleted','输入新密码':'Enter a new password',
  '删除后该渠道将从列表移除，登录和 API 访问立即停用。历史报表与已签合同保留。':'The channel will be removed from the list and its sign-in and API access revoked. Historical reports and signed agreements will be retained.',
  '此渠道仍关联 GAM 账号，请先将账号转移到其他渠道后删除':'Transfer the linked GAM accounts to another channel before deleting this channel.',
  'GAM 已确认网站':'Site verified in GAM','GAM 仅查到上级网站':'Only the parent site was found in GAM',
  '链接已保存，GAM 同步未确认':'Link saved. GAM sync could not be confirmed.',
  '同步 GAM':'Sync to GAM','保存并同步 GAM':'Save and sync to GAM',
  '新增链接会同步到所选账号的 GAM Sites。':'New links are synchronized to GAM Sites in the selected account.',
  '分配链接':'Assign website','已分配网站':'Assigned websites','网站域名':'Website domain','当前归属':'Current channel','搜索网站或账号':'Search websites or accounts',
  '网站与 GAM 账号':'Website and GAM account','搜索域名或 GAM 账号':'Search domain or GAM account','网站广告授权 TXT':'Ad authorization TXT',
  '保存分配':'Save assignment','网站分配已保存':'Website assignment saved','没有匹配的网站':'No matching websites','待录入':'Not entered',
  '粘贴对应账号的 TXT，每行一条':'Paste the account’s TXT entries, one per line','渠道管理分配':'Channel assignment',
  '保存后，所选域名在此 GAM 账号下的历史报表和回退记录对目标渠道可见。':'Saving grants the selected channel access to historical reports and rollback records for this domain on this GAM account.',
  '姓名':'Name',
  '密码（至少 10 位）':'Password (at least 10 characters)',
  '创建账号并进入合同管理':'Create account',
  '只需填写以下四项即可注册。登录后在合同管理完善资料和签署，网站将在后台关联。':'Enter these four details to register. After signing in, complete and sign the agreement in Contract Management. Your websites will be linked later.',
  '完成合同签署及审核前，账号仅可访问合同管理，不开放业务数据。':'Until the agreement is signed and approved, your account can access Contract Management only.',
  '登录后可在合同管理完善资料并签署；审核通过并关联数据后开放。':'Complete your details and sign the agreement in Contract Management. Data access opens after approval and assignment.',
  '合作协议':'Cooperation Agreement',
  '渠道方签署':'Channel signature',
  '签署合同并提交审核':'Sign agreement and submit for review',
  '下载双方签署 PDF':'Download signed PDF',
  '邮箱验证':'Email verification',
  '注册国家/地区':'Country or region of registration',
  '登录邮箱':'Email address',
};

export function getLocale() {
  try { return localStorage.getItem(storageKey) === 'en' ? 'en' : 'zh'; }
  catch { return 'zh'; }
}

export async function setLocale(locale) {
  if (locale !== 'zh' && locale !== 'en') return;
  try { localStorage.setItem(storageKey, locale); } catch { /* Storage may be unavailable. */ }
  await startI18n();
  window.dispatchEvent(new Event('adx:locale'));
}

function translate(value) {
  if (activeLocale !== 'en' || !dictionary || !chinese.test(value)) return value;
  if (dictionary[value]) return dictionary[value];
  const trimmed = value.trim();
  if (dictionary[trimmed]) return value.replace(trimmed, dictionary[trimmed]);
  return value.replace(fragments, match => dictionary[match] || match);
}

function excluded(element) {
  return element?.closest?.('.agreement-document,.language-switcher,.language-menu,.channel-txt,pre,code,script,style,textarea');
}

function translateNode(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    if (excluded(node.parentElement)) return;
    const value = node.nodeValue || '';
    const previous = originals.get(node);
    const source = previous?.rendered === value ? previous.source : value;
    const translated = translate(source);
    originals.set(node, { source, rendered:translated });
    if (translated !== node.nodeValue) node.nodeValue = translated;
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE || excluded(node)) return;
  for (const attribute of ['placeholder', 'title', 'aria-label']) {
    const value = node.getAttribute(attribute);
    if (value) {
      const values = originals.get(node) || {};
      const previous = values[attribute];
      const source = previous?.rendered === value ? previous.source : value;
      const translated = translate(source);
      values[attribute] = { source, rendered:translated };
      originals.set(node, values);
      if (translated !== value) node.setAttribute(attribute, translated);
    }
  }
  for (const child of node.childNodes) translateNode(child);
}

export async function startI18n() {
  if (getLocale() === 'en' && !dictionary) {
    loading ||= import('./locales/en.js');
    const { default: english } = await loading;
    dictionary = { ...english, ...overrides };
    const escapeRegex = value => value.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
    fragments = new RegExp(Object.keys(dictionary).filter(key => chinese.test(key))
      .sort((a,b) => b.length - a.length).map(escapeRegex).join('|'), 'g');
  }
  activeLocale = getLocale();
  document.documentElement.lang = activeLocale === 'en' ? 'en' : 'zh-CN';
  if (observer) {
    for (const record of observer.takeRecords()) {
      if (record.type === 'childList') for (const node of record.addedNodes) translateNode(node);
      else translateNode(record.target);
    }
  }
  translateNode(document.body);
  document.getElementById('boot-language-label')?.replaceChildren(activeLocale === 'en' ? 'EN' : '中文');
  const menu = document.getElementById('boot-language-menu');
  if (menu) menu.hidden = true;
  document.title = activeLocale === 'en' ? 'AdX Channel Management' : 'AdX 渠道管理';
  if (started) return;
  started = true;
  const pending = new Set();
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    for (const node of pending) translateNode(node);
    pending.clear();
  };
  observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'childList') for (const node of record.addedNodes) pending.add(node);
      else pending.add(record.target);
    }
    if (!scheduled && pending.size) { scheduled = true; queueMicrotask(flush); }
  });
  observer.observe(document.documentElement, { subtree:true, childList:true, characterData:true, attributes:true, attributeFilter:['placeholder','title','aria-label'] });

}
