import React, { useState } from 'react';
import { Alert, Button, ConfigProvider, Input, Typography } from 'antd';
import enUS from 'antd/locale/en_US';
import zhCN from 'antd/locale/zh_CN';
import { createRoot } from 'react-dom/client';
import LanguageSwitcher from './LanguageSwitcher.jsx';
import { getLocale } from './i18n.js';
import './channel-registration.css';
import './enterprise.css';
import { enterpriseTheme } from './enterpriseTheme.js';

const { Title, Text } = Typography;

export default function ChannelRegistration({ onBack, onRegistered }) {
  const [values, setValues] = useState({ contactName: '', companyName: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [complete, setComplete] = useState(false);
  const set = (field, value) => setValues(current => ({ ...current, [field]: value }));
  const submit = async event => {
    event.preventDefault();
    const email = values.email.trim();
    const at = email.indexOf('@');
    if (values.contactName.trim().length < 2 || values.companyName.trim().length < 2 ||
        at < 1 || email.lastIndexOf('.') <= at + 1 || email.includes(' ') || !values.password) {
      setError('请填写姓名、公司、有效邮箱和密码。');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const response = await fetch('/api/auth/register-channel', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...values, email })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.ok || !body.user) {
        throw new Error(body.error === 'registration_email_unavailable' ? '此邮箱已注册，请直接登录或联系运营。' : body.error || '注册失败，请稍后重试。');
      }
      setComplete(true);
      await onRegistered(body.user);
    } catch (cause) {
      setError(cause.message || '注册失败，请稍后重试。');
    } finally {
      setSubmitting(false);
    }
  };
  return <main className="channel-register-shell"><section className="channel-register-card">
    <header className="channel-register-brand"><div className="channel-register-logo"><img src="/google-g.png" alt="Google"/></div><div><strong>AdX Publisher</strong><small>渠道合作与数据工作台</small></div><div className="channel-register-actions"><LanguageSwitcher/><button type="button" onClick={onBack}>登录</button></div></header>
    {complete ? <div className="registration-complete"><div className="registration-complete-mark">✓</div><Title level={2}>账号已创建</Title><Text>请进入合同管理补全主体资料并签署合同；网站将在后台关联。</Text><Button type="primary" onClick={onBack}>进入合同管理</Button></div> : <>
      <Text className="registration-kicker">CHANNEL ACCOUNT</Text>
      <Title level={2} className="registration-title">创建渠道账号</Title>
      <Text type="secondary">只需填写以下四项即可注册。登录后在合同管理完善资料和签署，网站将在后台关联。</Text>
      {error && <Alert className="registration-error" type="error" showIcon message={error}/>}
      <form className="registration-grid" onSubmit={submit}>
        <label>姓名<Input autoComplete="name" maxLength={200} value={values.contactName} onChange={event => set('contactName', event.target.value)}/></label>
        <label>公司名称<Input autoComplete="organization" maxLength={200} value={values.companyName} onChange={event => set('companyName', event.target.value)}/></label>
        <label className="registration-wide">邮箱地址<Input autoComplete="email" type="email" maxLength={254} value={values.email} onChange={event => set('email', event.target.value)}/></label>
        <label className="registration-wide">密码<Input.Password autoComplete="new-password" value={values.password} onChange={event => set('password', event.target.value)}/></label>
        <Button htmlType="submit" type="primary" className="registration-primary registration-wide" loading={submitting}>创建账号并进入合同管理</Button>
      </form>
      <footer className="registration-footer">完成合同签署及审核前，账号仅可访问合同管理，不开放业务数据。</footer>
    </>}
  </section></main>;
}

export function mountChannelRegistration(onBack, onRegistered) {
  const root = createRoot(document.getElementById('root'));
  root.render(<ConfigProvider theme={enterpriseTheme} locale={getLocale() === 'en' ? enUS : zhCN}><ChannelRegistration onBack={onBack} onRegistered={onRegistered}/></ConfigProvider>);
  return root;
}
