const storageKey = 'adx_ui_language';
const chinese = /[\u3400-\u9fff]/;
let started = false;
let dictionary = null;
let fragments = null;
const overrides = {
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

export function setLocale(locale) {
  if (locale !== 'zh' && locale !== 'en') return;
  try { localStorage.setItem(storageKey, locale); } catch { /* Storage may be unavailable. */ }
  window.location.reload();
}

function translate(value) {
  if (!dictionary || !chinese.test(value)) return value;
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
    const translated = translate(node.nodeValue || '');
    if (translated !== node.nodeValue) node.nodeValue = translated;
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE || excluded(node)) return;
  for (const attribute of ['placeholder', 'title', 'aria-label']) {
    const value = node.getAttribute(attribute);
    if (value) {
      const translated = translate(value);
      if (translated !== value) node.setAttribute(attribute, translated);
    }
  }
  for (const child of node.childNodes) translateNode(child);
}

export async function startI18n() {
  document.documentElement.lang = getLocale() === 'en' ? 'en' : 'zh-CN';
  if (started || getLocale() !== 'en') return;
  started = true;
  const { default: english } = await import('./locales/en.js');
  dictionary = { ...english, ...overrides };
  const escapeRegex = value => value.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
  fragments = new RegExp(Object.keys(dictionary).filter(key => chinese.test(key))
    .sort((a,b) => b.length - a.length).map(escapeRegex).join('|'), 'g');
  const pending = new Set();
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    for (const node of pending) translateNode(node);
    pending.clear();
  };
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'childList') for (const node of record.addedNodes) pending.add(node);
      else pending.add(record.target);
    }
    if (!scheduled && pending.size) { scheduled = true; queueMicrotask(flush); }
  });
  observer.observe(document.documentElement, { subtree:true, childList:true, characterData:true, attributes:true, attributeFilter:['placeholder','title','aria-label'] });
  translateNode(document.body);
  document.title = 'AdX Channel Management';
}
