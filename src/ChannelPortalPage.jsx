import React, { useEffect, useState } from 'react';
import { Alert, Button, Card, Descriptions, Empty, Space, Spin, Tag, Typography, message } from 'antd';
import { FileProtectOutlined, LinkOutlined, ReloadOutlined } from '@ant-design/icons';
import { sessionFetch } from './sessionFetch.js';

const { Title, Text } = Typography;

async function request(path) {
  const response = await sessionFetch(path, { credentials: 'include', cache: 'no-store' });
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
    <div className="page-heading"><div><Title level={2}>我的链接</Title><Text type="secondary">仅显示运营后台已分配到本渠道的域名与对应账号 TXT</Text></div><Button icon={<ReloadOutlined/>} loading={loading} onClick={load}>刷新</Button></div>
    {items.length ? items.map(item => <Card key={item.domain} title={<Space><LinkOutlined/><span>{item.domain}</span></Space>} extra={item.accountName || item.networkCode || '账号待匹配'}>
      <Descriptions size="small" column={{xs:1,sm:2}} items={[
        {key:'status',label:'归属',children:<Tag color="green">已分配</Tag>},
        {key:'assigned',label:'分配时间',children:item.assignedAt || '—'}
      ]}/>
      <div className="channel-txt"><Text strong>adx.txt</Text><pre>{item.adxTxt || '运营后台尚未录入此域名的 adx.txt 内容'}</pre></div>
    </Card>) : <Card loading={loading}><Empty description="尚无分配到本渠道的域名"/></Card>}
  </Space>;
}

function ContractView() {
  const [contract, setContract] = useState(null);
  const [loading, setLoading] = useState(false);
  const load = async () => {
    setLoading(true);
    try { setContract((await request('/api/channel/contract')).contract || null); }
    catch (error) { message.error('合同读取失败：' + error.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);
  const registration = contract?.registration || {};
  const agreement = contract?.agreement || {};
  return <Space direction="vertical" size={16} className="page-stack">
    <div className="page-heading"><div><Title level={2}>我的合同</Title><Text type="secondary">渠道合同与双方电子签署记录</Text></div><Button icon={<ReloadOutlined/>} loading={loading} onClick={load}>刷新</Button></div>
    {loading && !contract ? <Card><Spin/></Card> : !contract ? <Card><Empty description="未找到合同申请记录"/></Card> :
      <><Card title={<Space><FileProtectOutlined/>签署信息</Space>} extra={<Tag color={contract.status === 'approved' ? 'green' : 'gold'}>{contract.status === 'approved' ? '双方签署并已审核' : contract.status === 'rejected' ? '申请未通过' : '已签署，等待运营复核'}</Tag>}>
        <Descriptions column={{xs:1,sm:2}} items={[
          {key:'company',label:'签约主体',children:registration.companyName},
          {key:'contact',label:'联系人',children:registration.contactName},
          {key:'registration',label:'注册编号',children:registration.registrationNumber},
          {key:'country',label:'注册国家/地区',children:registration.country},
          {key:'signed',label:'本人签署时间',children:agreement.signedAt || '—'},
          {key:'signer',label:'本人签署人',children:[agreement.signerName,agreement.signerTitle].filter(Boolean).join(' · ') || '—'},
          {key:'countersigner',label:'平台签署人',children:[agreement.counterSigner,agreement.counterSignerTitle].filter(Boolean).join(' · ') || '等待平台复核'},
          {key:'countersigned',label:'平台签署时间',children:agreement.countersignedAt || '—'},
          {key:'hash',label:'合同内容校验值',span:2,children:<Text code copyable>{agreement.contractHash || '—'}</Text>}
        ]}/>
        {agreement.signatureData && <div className="channel-signature"><Text strong>本人签名</Text><img src={agreement.signatureData} alt="本人电子签名"/></div>}
        {agreement.counterSignatureData && <div className="channel-signature"><Text strong>平台签名</Text><img src={agreement.counterSignatureData} alt="平台电子签名"/></div>}
        {registration.reviewNote && <Alert type="warning" showIcon message="审核说明" description={registration.reviewNote}/>}
      </Card><Card title="已签署协议全文"><Text type="secondary">版本：{agreement.version || '—'}</Text><pre className="contract-preview">{agreement.contractText || '合同内容暂不可用'}</pre></Card></>}
  </Space>;
}

export default function ChannelPortalPage({ view }) {
  return view === 'channel-contract' ? <ContractView/> : <AccountDomains/>;
}
