import React from 'react';

const sectionTitles = new Set([
  '合同项下可能涉及之名词解释', '合同有效期', '服务方式及结算', '结算时间',
  '甲方之陈述保证与权力义务', '甲方之陈述保证', '甲方之权利义务',
  '乙方之陈述保证与权利义务', '乙方之陈述保证', '乙方之权利义务',
  '甲乙双方的禁止性约定', '不可抗力', '违约责任', '争议解决', '其它约定', '反商业贿赂条款'
]);

export default function ContractDocument({ text }) {
  const lines = String(text || '').split(/\r?\n/);
  return <article className="agreement-document" aria-label="合作协议正文">
    {lines.map((line, index) => !line.trim() ? <div className="agreement-spacer" key={index}/> :
      index === 0 ? <header className="agreement-document-title" key={index}><h2>{line}</h2><div className="agreement-title-rule"/></header> :
      sectionTitles.has(line.trim()) ? <h3 className="agreement-section-title" key={index}>{line}</h3> :
      <p className={line.includes(' | ') ? 'agreement-signature-line' : undefined} key={index}>{line}</p>)}
  </article>;
}
