import React, { useEffect, useState } from 'react';
import { Alert, Button, Card, Checkbox, Descriptions, Empty, Input, Modal, Select, Space, Spin, Steps, Table, Tag, Typography, message } from 'antd';
import { BarChartOutlined, HistoryOutlined, ExpandOutlined, FileProtectOutlined, LinkOutlined, ReloadOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import SignaturePad from './SignaturePad.jsx';
import ContractDocument from './ContractDocument.jsx';
import { viewPaths } from './navigation.js';
import { countryOptions } from './countries.js';
import { getLocale } from './i18n.js';
import { sessionFetch } from './sessionFetch.js';
import './channel-registration.css';

const { Title, Text } = Typography;
const countryChoices = countryOptions(getLocale());

async function request(path, options = {}) {
  const response = await sessionFetch(path, { credentials:'include', cache:'no-store', ...options,
    headers:{ 'Content-Type':'application/json', ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) throw new Error(body.error || 'http_' + response.status);
  return body;
}

function AccountDomains() {
  const [items, setItems] = useState([]);
  const [search,setSearch]=useState('');
  const [loading, setLoading] = useState(false);
  const load = async () => {
    setLoading(true);
    try { setItems((await request('/api/channel/domains')).items || []); }
    catch (error) { message.error('链接读取失败：' + error.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);
  return <Space direction="vertical" size={16} className="page-stack">
    <div className="page-heading"><div><Title level={2}>我的链接</Title><Text type="secondary">仅显示后台已分配到本渠道的网站与对应账号 TXT</Text></div><Button icon={<ReloadOutlined/>} loading={loading} onClick={load}>刷新</Button></div>
    <Card className="publisher-site-list" title={<Space><LinkOutlined/>已分配网站<Tag>{items.length}</Tag></Space>}
      extra={<Input.Search allowClear placeholder="搜索网站或账号" value={search} onChange={e=>setSearch(e.target.value)}/>}>
      <Table size="middle" loading={loading} rowKey={row=>row.networkCode+':'+row.domain}
        pagination={{pageSize:12,hideOnSinglePage:true}} scroll={{x:650}}
        locale={{emptyText:<Empty description={search?'没有匹配的网站':'后台尚未分配网站'}/>}}
        dataSource={items.filter(row=>[row.domain,row.accountName,row.networkCode].some(v=>String(v||'').toLowerCase().includes(search.trim().toLowerCase())))}
        columns={[
          {title:'网站域名',dataIndex:'domain',render:value=><Text strong copyable>{value}</Text>},
          {title:'GAM 账号',render:(_,row)=><Space direction="vertical" size={0}><Text>{row.accountName||'—'}</Text><Text type="secondary">{row.networkCode}</Text></Space>},
          {title:'网站广告授权 TXT',dataIndex:'adxTxt',render:value=>value?<Text className="publisher-txt" copyable={{text:value}}>{value}</Text>:<Text type="secondary">待录入</Text>},
          {title:'分配时间',dataIndex:'assignedAt'}
        ]}/>
    </Card>
  </Space>;
}

function AgreementPreview({ text, registration, values }) {
  let output = String(text || '');
  for (const [placeholder, value] of [
    ['[公司法定名称]',registration.companyName],['[公司注册地址]',values.registeredAddress],
    ['[联系人姓名]',registration.contactName],['[联系电话]',values.phone],
    ['[签约邮箱]',registration.email],['[签署人姓名]',registration.contactName],
    ['[注册编号]',values.registrationNumber],['[注册国家/地区]',values.country]
  ]) output = output.split(placeholder).join(value || placeholder);
  return <>{getLocale() === 'en' && <Alert type="info" showIcon style={{marginBottom:12}} message="The agreement remains in its original Chinese signing language; interface translations do not change its legal text."/>}<ContractDocument text={output}/></>;
}

function ContractView({ user }) {
  const [contract, setContract] = useState(null);
  const [template, setTemplate] = useState(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [codeSending, setCodeSending] = useState(false);
  const [codeSent, setCodeSent] = useState(false);
  const [codeCooldown, setCodeCooldown] = useState(0);
  const [reading, setReading] = useState(false);
  const [values, setValues] = useState({ registrationNumber:'', country:'', registeredAddress:'', phone:'', signatureTitle:'', signatureData:'', verificationCode:'', accepted:false });
  const set = (field, value) => setValues(current => ({ ...current, [field]:value }));
  const load = async () => {
    setLoading(true);
    try {
      const current = (await request('/api/channel/contract')).contract;
      setContract(current);
      if (current?.status === 'registered' && user?.status === 'pending') setTemplate(await request('/api/public/channel-contract'));
      if (current?.status === 'approved' && user?.status === 'pending') {
        const identity = await request('/api/auth/me');
        if (identity.user?.status === 'active') window.location.reload();
      }
    } catch (error) { message.error('合同信息读取失败：' + error.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (!codeCooldown) return undefined;
    const timer = window.setTimeout(() => setCodeCooldown(seconds => Math.max(0, seconds - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [codeCooldown]);
  const registration = contract?.registration || {};
  const agreement = contract?.agreement || {};
  const sendCode = async () => {
    if (values.registrationNumber.trim().length < 2 || values.country.trim().length < 2 ||
        values.registeredAddress.trim().length < 8 || values.phone.trim().length < 5 ||
        values.signatureTitle.trim().length < 2 || !template?.version) {
      message.warning('请先补全主体资料和签署职务。'); return;
    }
    setCodeSending(true);
    try {
      await request('/api/channel/contract/email-code', { method:'POST', body:JSON.stringify({
        registrationNumber:values.registrationNumber, country:values.country,
        registeredAddress:values.registeredAddress, phone:values.phone,
        signatureName:registration.contactName, signatureTitle:values.signatureTitle,
        contractVersion:template.version
      }) });
      setCodeSent(true);
      setCodeCooldown(60);
      message.success('验证码已提交发送到注册邮箱，15 分钟内有效；未收到请检查垃圾邮件。');
    } catch (error) {
      if (error.message === 'contract_code_rate_limited') setCodeCooldown(60);
      const details = {
        contract_code_rate_limited:'发送过于频繁，请稍后重试。',
        contract_email_send_failed:'邮件服务未接受本次发送，请稍后重试。',
        contract_email_unconfigured:'签约邮件服务尚未配置，请联系平台管理员。',
        invalid_contract_details:'请检查注册编号、国家、地址、电话和签署职务。'
      };
      message.error('验证码发送失败：' + (details[error.message] || error.message));
    }
    finally { setCodeSending(false); }
  };
  const sign = async () => {
    if (values.registrationNumber.trim().length < 2 || values.country.trim().length < 2 ||
        values.registeredAddress.trim().length < 8 || values.phone.trim().length < 5 ||
        values.signatureTitle.trim().length < 2 || !values.signatureData || !values.accepted || !template?.version ||
        (contract?.emailVerificationRequired && !/^[0-9]{6}$/.test(values.verificationCode.trim()))) {
      message.warning(contract?.emailVerificationRequired && !/^[0-9]{6}$/.test(values.verificationCode.trim()) ? '请填写邮箱收到的 6 位验证码。' : '请补全主体资料、签署职务、手写签名并勾选确认。');
      return;
    }
    setSubmitting(true);
    try {
      await request('/api/channel/contract/sign', { method:'POST', body:JSON.stringify({
        ...values, signatureName:registration.contactName, contractVersion:template.version
      }) });
      message.success('合同已签署并提交审核');
      await load();
    } catch (error) { message.error('签署失败：' + error.message); }
    finally { setSubmitting(false); }
  };
  const statusText = contract?.status === 'registered' ? '账号已创建，请完成合同资料和签署。' :
    contract?.status === 'signed' ? '合同已提交审核，等待平台签署。' :
    contract?.status === 'approved' ? '合同已由双方签署。' : '申请未通过，请联系平台。';
  const allocation = '平台已关联 ' + (contract?.gamAccountCount || 0) + ' 个 GAM 账号、' + (contract?.assignedDomainCount || 0) + ' 个网站。';
  return <Space direction="vertical" size={20} className="page-stack contract-workspace">
    <div className="page-heading"><div><Title level={2}>合同管理</Title><Text type="secondary">补全签约主体资料、查看协议并签署；网站将在后台关联。</Text></div><Button icon={<ReloadOutlined/>} loading={loading} onClick={load}>刷新</Button></div>
    {loading && !contract ? <Card><Spin/></Card> : !contract ? <Card><Empty description="合同信息暂不可用"/></Card> : <>
      <section className="contract-progress-panel">
        <div className="contract-progress-heading"><span className="contract-progress-icon"><SafetyCertificateOutlined/></span><div><strong>{statusText}</strong><p>{contract.status === 'approved' ? allocation : '完成合同签署与审核后，账号和网站将在后台关联。'}</p></div></div>
        <Steps size="small" current={contract.status === 'registered' ? 0 : contract.status === 'approved' ? 2 : 1} status={contract.status === 'rejected' ? 'error' : undefined}
          items={[{title:'完善资料与签署'},{title:'平台复核与签署'},{title:'开通工作台',status:contract.status === 'approved' ? 'finish' : undefined}]}/>
      </section>
      {contract.status === 'approved' && <nav className="publisher-tools">
        <a href={viewPaths['channel-links']}><LinkOutlined/>我的链接</a>
        <a href={viewPaths.reports}><BarChartOutlined/>数据报告</a>
        <a href={viewPaths['channel-regression']}><HistoryOutlined/>数据回退</a>
      </nav>}
      {contract.status === 'registered' && user?.status === 'pending' ? <>
        <Card className="contract-profile-card" title={<Space><FileProtectOutlined/>签约主体资料</Space>} extra={<Tag color="blue">签约主体</Tag>}>
          <Descriptions size="small" column={{xs:1,sm:2}} items={[
            {key:'company',label:'公司名称',children:registration.companyName},
            {key:'contact',label:'姓名',children:registration.contactName},
            {key:'email',label:'注册邮箱',children:registration.email}
          ]}/>
          <div className="registration-grid">
            <label>公司注册编号<Input maxLength={100} value={values.registrationNumber} onChange={event => set('registrationNumber',event.target.value)}/></label>
            <label>注册国家/地区<Select showSearch allowClear placeholder="选择国家或地区" value={values.country || undefined} options={countryChoices}
              filterOption={(input,option) => option.searchText.includes(input.toLowerCase())} onChange={value => set('country',value || '')}/></label>
            <label className="registration-wide">公司注册地址<Input.TextArea rows={2} maxLength={800} value={values.registeredAddress} onChange={event => set('registeredAddress',event.target.value)}/></label>
            <label className="registration-wide">联系电话<Input maxLength={80} value={values.phone} onChange={event => set('phone',event.target.value)}/></label>
          </div>
        </Card>
        <div className="contract-signing-layout">
        <Card className="contract-reading-card" title={<Space><FileProtectOutlined/>合作协议</Space>} extra={<Button type="text" icon={<ExpandOutlined/>} onClick={() => setReading(true)} disabled={!template}>展开阅读</Button>}>
          <div className="contract-document-toolbar"><span>协议正文</span></div>
          <div className="contract-reading-area" tabIndex={0} aria-label="阅读合作协议">{template ? <AgreementPreview text={template.text} registration={registration} values={values}/> : <Spin/>}</div>
        </Card>
        <Card className="contract-signing-card" title="渠道方签署">
          <p className="contract-signing-hint">核对上方协议及主体资料后，完成以下签署信息。</p>
          <div className="registration-grid registration-signer contract-signer-fields">
            <label>签署人<Input value={registration.contactName || ''} disabled/></label>
            <label>签署人职务<Input maxLength={150} value={values.signatureTitle} onChange={event => set('signatureTitle',event.target.value)}/></label>
          </div>
          {contract.emailVerificationRequired && <div className="contract-email-verification">
            <strong>邮箱验证</strong><Text type="secondary">签署验证码将发送至 {registration.email}，15 分钟内有效。</Text>
            <div className="contract-email-code-row"><Input inputMode="numeric" maxLength={6} placeholder="6 位邮箱验证码" value={values.verificationCode}
              onChange={event => set('verificationCode',event.target.value.replace(/\D/g,''))}/><Button onClick={sendCode} loading={codeSending} disabled={codeCooldown>0}>{codeCooldown>0?codeCooldown+' 秒后重发':codeSent?'重新发送':'发送验证码'}</Button></div>
          </div>}
          <SignaturePad width={1200} height={320} onChange={value => set('signatureData',value)}/>
          <Checkbox checked={values.accepted} onChange={event => set('accepted',event.target.checked)} style={{marginTop:16}}>本人已核对主体资料、阅读完整协议，并确认有权代表该公司签署；同意留存签名、签署时间与审计记录。</Checkbox>
          <div className="registration-actions"><Button type="primary" size="large" block loading={submitting} onClick={sign}>签署合同并提交审核</Button></div>
          <div className="contract-signing-security"><SafetyCertificateOutlined/><span>签名与签署时间将安全留存</span></div>
        </Card>
        </div>
        <Modal className="agreement-reading-modal" open={reading} onCancel={() => setReading(false)} width={1000} title="合作协议全文" footer={<Button onClick={() => setReading(false)}>返回签署</Button>}>
          {template && <AgreementPreview text={template.text} registration={registration} values={values}/>}
        </Modal>
      </> : contract.status === 'registered' ? <Card><Alert type="warning" showIcon message="当前账户尚未创建合同，请联系平台补充主体资料。"/></Card> : <>
        {contract.status === 'approved' && contract.emailDelivery && <Alert showIcon type={contract.emailDelivery.status === 'sent' ? 'success' : 'info'}
          message={contract.emailDelivery.status === 'sent' ? '签署版 PDF 已提交邮件发送' : contract.emailDelivery.status === 'failed' && contract.emailDelivery.attempts >= 8 ? '邮件发送失败，可在下方下载签署版 PDF' : '签署版 PDF 邮件正在发送或重试'}
          description="邮件发往注册邮箱；若未见邮件，请查看垃圾邮件。您也可以在下方直接下载合同。"/>}
        <Card title={<Space><FileProtectOutlined/>签署信息</Space>} extra={<Tag color={contract.status === 'approved' ? 'green' : contract.status === 'rejected' ? 'red' : 'gold'}>{contract.status === 'approved' ? '双方已签署' : contract.status === 'rejected' ? '申请未通过' : '等待平台复核'}</Tag>}>
          <Descriptions column={{xs:1,sm:2}} items={[
            {key:'company',label:'签约主体',children:registration.companyName},
            {key:'contact',label:'联系人',children:registration.contactName},
            {key:'registration',label:'注册编号',children:registration.registrationNumber},
            {key:'country',label:'注册国家/地区',children:registration.country},
            {key:'signed',label:'渠道方签署时间',children:agreement.signedAt || '—'},
            {key:'signer',label:'渠道方签署人',children:[agreement.signerName,agreement.signerTitle].filter(Boolean).join(' · ') || '—'},
            {key:'countersigner',label:'平台签署人',children:[agreement.counterSigner,agreement.counterSignerTitle].filter(Boolean).join(' · ') || '等待复核'},
            {key:'countersigned',label:'平台签署时间',children:agreement.countersignedAt || '—'},
            {key:'hash',label:'合同内容校验值',span:2,children:<Text code copyable>{agreement.contractHash || '—'}</Text>},
            ...(agreement.signedPdfSha256 ? [{key:'pdfHash',label:'签署 PDF 校验值',span:2,children:<Text code copyable>{agreement.signedPdfSha256}</Text>}] : [])
          ]}/>
          {agreement.signatureData && <div className="channel-signature"><Text strong>渠道方签名</Text><img src={agreement.signatureData} alt="渠道方电子签名"/></div>}
          {agreement.counterSignatureData && <div className="channel-signature"><Text strong>平台签名</Text><img src={agreement.counterSignatureData} alt="平台电子签名"/></div>}
          {registration.reviewNote && <Alert type="warning" showIcon message="审核说明" description={registration.reviewNote}/>}
        </Card>
        <Card className="contract-reading-card" title="已签署协议全文" extra={contract.status === 'approved' && agreement.counterSignatureData && <Button type="primary" href="/api/channel/contract/pdf" download>下载双方签署 PDF</Button>}><div className="contract-document-toolbar"><span>原始签署正文</span></div><div className="contract-reading-area" tabIndex={0}><ContractDocument text={agreement.contractText || '合同内容暂不可用'}/></div></Card>
      </>}
    </>}
  </Space>;
}

export default function ChannelPortalPage({ view, user }) {
  return view === 'channel-contract' ? <ContractView user={user}/> : <AccountDomains/>;
}
