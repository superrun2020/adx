import React, { useEffect, useState } from 'react';
import { Alert, Button, Card, Checkbox, Descriptions, Empty, Input, Space, Spin, Tag, Typography, message } from 'antd';
import { FileProtectOutlined, LinkOutlined, ReloadOutlined } from '@ant-design/icons';
import SignaturePad from './SignaturePad.jsx';
import { sessionFetch } from './sessionFetch.js';
import './channel-registration.css';

const { Title, Text } = Typography;

async function request(path, options = {}) {
  const response = await sessionFetch(path, { credentials:'include', cache:'no-store', ...options,
    headers:{ 'Content-Type':'application/json', ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) throw new Error(body.error || 'http_' + response.status);
  return body;
}

function AccountDomains() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const load = async () => {
    setLoading(true);
    try { setItems((await request('/api/channel/domains')).items || []); }
    catch (error) { message.error('链接读取失败：' + error.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);
  return <Space direction="vertical" size={16} className="page-stack">
    <div className="page-heading"><div><Title level={2}>我的链接</Title><Text type="secondary">仅显示运营后台已分配到本渠道的网站与对应账号 TXT</Text></div><Button icon={<ReloadOutlined/>} loading={loading} onClick={load}>刷新</Button></div>
    {items.length ? items.map(item => <Card key={item.networkCode + ':' + item.domain} title={<Space><LinkOutlined/><span>{item.domain}</span></Space>} extra={item.accountName || item.networkCode || '账号待匹配'}>
      <Descriptions size="small" column={{xs:1,sm:2}} items={[
        {key:'status',label:'归属',children:<Tag color="green">已分配</Tag>},
        {key:'assigned',label:'分配时间',children:item.assignedAt || '—'}
      ]}/>
      <div className="channel-txt"><Text strong>adx.txt</Text><pre>{item.adxTxt || '运营后台尚未录入此域名的 adx.txt 内容'}</pre></div>
    </Card>) : <Card loading={loading}><Empty description="运营后台尚未分配网站"/></Card>}
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
  return <pre className="contract-preview registration-agreement">{output}</pre>;
}

function ContractView({ user }) {
  const [contract, setContract] = useState(null);
  const [template, setTemplate] = useState(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [values, setValues] = useState({ registrationNumber:'', country:'', registeredAddress:'', phone:'', signatureTitle:'', signatureData:'', accepted:false });
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
  const registration = contract?.registration || {};
  const agreement = contract?.agreement || {};
  const sign = async () => {
    if (values.registrationNumber.trim().length < 2 || values.country.trim().length < 2 ||
        values.registeredAddress.trim().length < 8 || values.phone.trim().length < 5 ||
        values.signatureTitle.trim().length < 2 || !values.signatureData || !values.accepted || !template?.version) {
      message.warning('请补全主体资料、签署职务、手写签名并勾选确认。');
      return;
    }
    setSubmitting(true);
    try {
      await request('/api/channel/contract/sign', { method:'POST', body:JSON.stringify({
        ...values, signatureName:registration.contactName, contractVersion:template.version
      }) });
      message.success('合同已签署，等待运营复核与平台签名');
      await load();
    } catch (error) { message.error('签署失败：' + error.message); }
    finally { setSubmitting(false); }
  };
  const statusText = contract?.status === 'registered' ? '账号已创建，请完成合同资料和签署。' :
    contract?.status === 'signed' ? '渠道方已签署，等待运营平台复核。' :
    contract?.status === 'approved' ? '合同已由双方签署。' : '申请未通过，请联系运营。';
  const allocation = '运营已关联 ' + (contract?.gamAccountCount || 0) + ' 个 GAM 账号、' + (contract?.assignedDomainCount || 0) + ' 个网站。';
  return <Space direction="vertical" size={16} className="page-stack">
    <div className="page-heading"><div><Title level={2}>合同管理</Title><Text type="secondary">补全签约主体资料、查看协议并签署；网站由运营后台关联。</Text></div><Button icon={<ReloadOutlined/>} loading={loading} onClick={load}>刷新</Button></div>
    {loading && !contract ? <Card><Spin/></Card> : !contract ? <Card><Empty description="合同信息暂不可用"/></Card> : <>
      <Alert showIcon type={contract.status === 'approved' ? 'success' : 'info'} message={statusText}
        description={contract.status === 'approved' ? allocation : '完成合同签署及运营复核前，账号不开放业务数据。'}/>
      {contract.status === 'registered' && user?.status === 'pending' ? <>
        <Card title={<Space><FileProtectOutlined/>签约主体资料</Space>}>
          <Descriptions size="small" column={{xs:1,sm:2}} items={[
            {key:'company',label:'公司名称',children:registration.companyName},
            {key:'contact',label:'姓名',children:registration.contactName},
            {key:'email',label:'注册邮箱',children:registration.email}
          ]}/>
          <div className="registration-grid">
            <label>公司注册编号<Input maxLength={100} value={values.registrationNumber} onChange={event => set('registrationNumber',event.target.value)}/></label>
            <label>注册国家/地区<Input maxLength={100} value={values.country} onChange={event => set('country',event.target.value)}/></label>
            <label className="registration-wide">公司注册地址<Input.TextArea rows={2} maxLength={800} value={values.registeredAddress} onChange={event => set('registeredAddress',event.target.value)}/></label>
            <label className="registration-wide">联系电话<Input maxLength={80} value={values.phone} onChange={event => set('phone',event.target.value)}/></label>
          </div>
        </Card>
        <Card title="合作协议与渠道签署">
          {template ? <AgreementPreview text={template.text} registration={registration} values={values}/> : <Spin/>}
          <div className="registration-grid registration-signer">
            <label>签署人<Input value={registration.contactName || ''} disabled/></label>
            <label>签署人职务<Input maxLength={150} value={values.signatureTitle} onChange={event => set('signatureTitle',event.target.value)}/></label>
          </div>
          <SignaturePad onChange={value => set('signatureData',value)}/>
          <Checkbox checked={values.accepted} onChange={event => set('accepted',event.target.checked)} style={{marginTop:16}}>本人已核对主体资料、阅读完整协议，并确认有权代表该公司签署；同意留存签名、签署时间与审计记录。</Checkbox>
          <div className="registration-actions"><Button type="primary" loading={submitting} onClick={sign}>签署合同并提交运营复核</Button></div>
        </Card>
      </> : contract.status === 'registered' ? <Card><Alert type="warning" showIcon message="当前账户尚未创建合同，请联系运营补充主体资料。"/></Card> : <>
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
            {key:'hash',label:'合同内容校验值',span:2,children:<Text code copyable>{agreement.contractHash || '—'}</Text>}
          ]}/>
          {agreement.signatureData && <div className="channel-signature"><Text strong>渠道方签名</Text><img src={agreement.signatureData} alt="渠道方电子签名"/></div>}
          {agreement.counterSignatureData && <div className="channel-signature"><Text strong>平台签名</Text><img src={agreement.counterSignatureData} alt="平台电子签名"/></div>}
          {registration.reviewNote && <Alert type="warning" showIcon message="审核说明" description={registration.reviewNote}/>}
        </Card>
        <Card title="已签署协议全文"><Text type="secondary">版本：{agreement.version || '—'}</Text><pre className="contract-preview">{agreement.contractText || '合同内容暂不可用'}</pre></Card>
      </>}
    </>}
  </Space>;
}

export default function ChannelPortalPage({ view, user }) {
  return view === 'channel-contract' ? <ContractView user={user}/> : <AccountDomains/>;
}
