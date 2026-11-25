import useLocale from './useLocale.js';
import React from 'react';
import { Button, Dropdown } from 'antd';
import { GlobalOutlined } from '@ant-design/icons';
import { getLocale, setLocale } from './i18n.js';
import './language.css';

export default function LanguageSwitcher() {
  const current = useLocale();
  return <span className="language-switcher"><Dropdown trigger={['click']} placement="bottomRight" overlayClassName="language-menu" menu={{
    selectable:true, selectedKeys:[current],
    items:[{key:'zh',label:'中文'},{key:'en',label:'English'}],
    onClick:({key}) => setLocale(key)
  }}><Button icon={<GlobalOutlined/>} aria-label="Language / 语言" className="language-switcher-button">{current === 'en' ? 'EN' : '中文'}</Button></Dropdown></span>;
}
