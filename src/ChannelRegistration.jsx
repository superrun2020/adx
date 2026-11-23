import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Input, Steps, Typography, message } from 'antd';
import { ArrowLeftOutlined, ArrowRightOutlined, PlusOutlined, DeleteOutlined } from '@ant-design/icons';
import { createRoot } from 'react-dom/client';
import './channel-registration.css';

const { Title, Text } = Typography;

export function SignaturePad({ onChange, title = '电子手写签名', className = '' }) {
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.lineWidth = 3;
    context.strokeStyle = '#163b72';
  }, []);
  const point = event => {
    const rect = canvasRef.current.getBoundingClientRect();
    return {x:(event.clientX-rect.left)*canvasRef.current.width/rect.width,y:(event.clientY-rect.top)*canvasRef.current.height/rect.height};
  };
  const start = event => {
    const canvas=canvasRef.current,context=canvas?.getContext('2d');
    if (!canvas||!context) return;
    canvas.setPointerCapture(event.pointerId);
    drawing.current=true;
    const p=point(event);
    context.beginPath();
    context.moveTo(p.x,p.y);
  };
  const move = event => {
    if(!drawing.current)return;
    const context=canvasRef.current?.getContext('2d');
    if(!context)return;
    const p=point(event);
    context.lineTo(p.x,p.y);
    context.stroke();
  };
  const finish = () => {
    if(!drawing.current)return;
    drawing.current=false;
    onChange(canvasRef.current?.toDataURL('image/png')||'');
  };
  const clear = () => {
    const canvas=canvasRef.current,context=canvas?.getContext('2d');
    if(!canvas||!context)return;
    context.clearRect(0,0,canvas.width,canvas.height);
    context.fillStyle='#ffffff';
    context.fillRect(0,0,canvas.width,canvas.height);
    onChange('');
  };
  return <div className={'registration-signature ' + className}>
    <div className="registration-signature-heading"><strong>{title}</strong><Button type="link" size="small" onClick={clear}>清除重签</Button></div>
    <canvas ref={canvasRef} width={840} height={220} onPointerDown={start} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} aria-label="请在此手写签名"/>
    <Text type="secondary">使用鼠标、触控板或手机手指签名。签名图及时间会作为合同签署记录留存。</Text>
  </div>;
}

function AgreementPreview({ text, values }) {
  let output = String(text || '');
  for (const [placeholder, value] of [
    ['[公司法定名称]',values.companyName],['[公司注册地址]',values.registeredAddress],
    ['[联系人姓名]',values.contactName],['[联系电话]',values.phone],['[签约邮箱]',values.email],
    ['[签署人姓名]',values.signatureName],['[注册编号]',values.registrationNumber],['[注册国家/地区]',values.country]
  ]) output = output.split(placeholder).join(value || placeholder);
  return <pre className="contract-preview registration-agreement">{output}</pre>;
}

export default function ChannelRegistration({ onBack }) {
  const [step,setStep]=useState(0);
  const [contract,setContract]=useState(null);
  const [contractLoading,setContractLoading]=useState(false);
  const [submitting,setSubmitting]=useState(false);
  const [complete,setComplete]=useState(false);
  const [values,setValues]=useState({contactName:'',companyName:'',email:'',password:'',registrationNumber:'',country:'',registeredAddress:'',phone:'',signatureName:'',signatureTitle:'',signatureData:'',domains:[{domain:'',adxTxt:''}],accepted:false});
  const [error,setError]=useState('');
  const set=(key,value)=>setValues(current=>({...current,[key]:value}));
  const setDomain=(index,key,value)=>setValues(current=>({...current,domains:current.domains.map((row,i)=>i===index?{...row,[key]:value}:row)}));
  const nextFromAccount=()=>{
    const email = values.email.trim();
    const at = email.indexOf('@');
    if(values.contactName.trim().length<2||values.companyName.trim().length<2||at<1||email.lastIndexOf('.')<=at+1||email.includes(' ')||values.password.length<10) {
      setError('请填写有效姓名、公司、邮箱，并设置至少 10 位密码。');
      return;
    }
    setError('');
    setStep(1);
  };
  const loadContract=async()=>{
    if(!values.registrationNumber.trim()||!values.country.trim()||values.registeredAddress.trim().length<8||values.phone.trim().length<5||
      values.domains.some(row=>!row.domain.trim()||!row.adxTxt.trim())) {
      setError('请补全公司登记资料、联系电话，并填写每个域名的 adx.txt 内容。');
      return;
    }
    setContractLoading(true);
    setError('');
    try {
      const response=await fetch('/api/public/channel-contract',{cache:'no-store'});
      const body=await response.json().catch(()=>({}));
      if(!response.ok||!body.ok)throw new Error(body.error||'合同模板读取失败');
      setContract(body);
      setValues(current=>({...current,signatureName:current.contactName,signatureTitle:current.signatureTitle||'授权代表'}));
      setStep(2);
    } catch(cause) {setError(cause.message||'合同模板读取失败');}
    finally {setContractLoading(false);}
  };
  const submit=async()=>{
    if(!contract||!values.signatureData||!values.accepted||values.signatureName.trim()!==values.contactName.trim()||values.signatureTitle.trim().length<2){
      setError('请核对签署人姓名，填写职务，手写签名并勾选确认。');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const payload={...values,contractVersion:contract.version};
      const response=await fetch('/api/auth/register-channel',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      const body=await response.json().catch(()=>({}));
      if(!response.ok||!body.ok)throw new Error(body.error==='registration_email_unavailable'?'此邮箱已注册，请直接登录或联系运营。':body.error||'注册未完成');
      setComplete(true);
      message.success('注册和合同签署资料已提交');
    } catch(cause) {setError(cause.message||'注册未完成');}
    finally {setSubmitting(false);}
  };
  return <main className="channel-register-shell"><section className="channel-register-card">
    <header className="channel-register-brand"><div className="channel-register-logo"><img src="/google-g.png" alt="Google"/></div><div><strong>AdX Publisher</strong><small>渠道合作与数据工作台</small></div><button type="button" onClick={onBack}>登录</button></header>
    {complete?<div className="registration-complete"><div className="registration-complete-mark">✓</div><Title level={2}>申请已提交</Title><Text>合同已由你签署。运营审核公司资料、域名、GAM 账号和 adx.txt 后会完成平台签署并开通渠道登录权限。</Text><Button type="primary" onClick={onBack}>返回登录</Button></div>:<>
      <Text className="registration-kicker">CHANNEL ACCOUNT</Text>
      <Title level={2} className="registration-title">{step===2?'核对并签署合作协议':step===1?'填写主体与域名资料':'创建渠道账号'}</Title>
      <Text type="secondary">{step===0?'注册资料用于建立渠道账户，注册完成后还需签署合作协议并通过运营审核。':'开户资料、域名和合同都要审核通过后才会开通数据权限。'}</Text>
      <Steps className="registration-steps" size="small" current={step} items={[{title:'账号'},{title:'资料'},{title:'签署'}]}/>
      {error&&<Alert className="registration-error" type="error" showIcon message={error}/>}
      {step===0&&<div className="registration-grid">
        <label>姓名<Input autoComplete="name" maxLength={200} value={values.contactName} onChange={e=>set('contactName',e.target.value)}/></label>
        <label>公司名称<Input autoComplete="organization" maxLength={200} value={values.companyName} onChange={e=>set('companyName',e.target.value)}/></label>
        <label className="registration-wide">邮箱地址<Input autoComplete="email" type="email" maxLength={254} value={values.email} onChange={e=>set('email',e.target.value)}/></label>
        <label className="registration-wide">密码（至少 10 位）<Input.Password autoComplete="new-password" minLength={10} value={values.password} onChange={e=>set('password',e.target.value)}/></label>
        <Button type="primary" className="registration-primary registration-wide" icon={<ArrowRightOutlined/>} onClick={nextFromAccount}>继续填写</Button>
      </div>}
      {step===1&&<div className="registration-profile">
        <div className="registration-grid">
          <label>公司注册编号<Input maxLength={100} value={values.registrationNumber} onChange={e=>set('registrationNumber',e.target.value)}/></label>
          <label>注册国家/地区<Input maxLength={100} value={values.country} onChange={e=>set('country',e.target.value)}/></label>
          <label className="registration-wide">公司注册地址<Input.TextArea rows={2} maxLength={800} value={values.registeredAddress} onChange={e=>set('registeredAddress',e.target.value)}/></label>
          <label className="registration-wide">联系电话<Input autoComplete="tel" maxLength={80} value={values.phone} onChange={e=>set('phone',e.target.value)}/></label>
        </div>
        <div className="registration-domains-heading"><div><strong>申请关联的网站</strong><Text type="secondary">每个网站对应一条 adx.txt 内容，审核时运营会匹配到真实 GAM 账号。</Text></div><Button icon={<PlusOutlined/>} onClick={()=>setValues(current=>({...current,domains:[...current.domains,{domain:'',adxTxt:''}]}))}>添加网站</Button></div>
        {values.domains.map((row,index)=><div className="registration-domain" key={index}><div className="registration-domain-heading"><strong>网站 {index+1}</strong>{values.domains.length>1&&<Button type="text" danger icon={<DeleteOutlined/>} aria-label="移除此网站" onClick={()=>setValues(current=>({...current,domains:current.domains.filter((_,i)=>i!==index)}))}/>}</div><label>域名<Input maxLength={253} placeholder="example.com" value={row.domain} onChange={e=>setDomain(index,'domain',e.target.value)}/></label><label>对应账号的 adx.txt 信息<Input.TextArea rows={3} maxLength={64000} placeholder="粘贴这个域名现有的完整 adx.txt 内容" value={row.adxTxt} onChange={e=>setDomain(index,'adxTxt',e.target.value)}/></label></div>)}
        <div className="registration-actions"><Button icon={<ArrowLeftOutlined/>} onClick={()=>setStep(0)}>上一步</Button><Button type="primary" loading={contractLoading} onClick={loadContract}>查看合同并签署</Button></div>
      </div>}
      {step===2&&<div className="registration-signing">
        <div className="registration-company-summary"><strong>{values.companyName}</strong><span>{values.email}</span><span>{values.domains.map(row=>row.domain).join('、')}</span></div>
        {contractLoading?<Spin/>:<AgreementPreview text={contract?.text} values={values}/>}
        <div className="registration-grid registration-signer">
          <label>签署人真实姓名<Input autoComplete="name" maxLength={200} value={values.signatureName} onChange={e=>set('signatureName',e.target.value)}/></label>
          <label>签署人职务<Input maxLength={150} value={values.signatureTitle} onChange={e=>set('signatureTitle',e.target.value)}/></label>
        </div>
        <SignaturePad onChange={value=>set('signatureData',value)}/>
        <Checkbox checked={values.accepted} onChange={e=>set('accepted',e.target.checked)}>本人确认已核对公司信息和申请网站、已阅读完整协议、具有代表该主体签署的授权，并同意电子签名及留存签署时间与审计记录。</Checkbox>
        <div className="registration-actions"><Button icon={<ArrowLeftOutlined/>} onClick={()=>setStep(1)}>返回修改资料</Button><Button type="primary" loading={submitting} onClick={submit}>签署协议并提交审核</Button></div>
      </div>}
      <footer className="registration-footer">提交后不会立即开放数据权限。运营需逐个确认网站、adx.txt 与 GAM 账号归属并完成平台签署。</footer>
    </>}
  </section></main>;
}

export function mountChannelRegistration(onBack) {
  const root = document.getElementById('root');
  return createRoot(root).render(<ChannelRegistration onBack={onBack}/>);
}
