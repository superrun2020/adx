import React, { useEffect, useRef } from 'react';
import { Button, Typography } from 'antd';

export default function SignaturePad({ onChange, title = '电子手写签名' }) {
  const canvasRef = useRef(null);
  const drawing = useRef(false);
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!context) return;
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.lineWidth = 3;
    context.strokeStyle = '#163b72';
  }, []);
  const point = event => {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * canvas.width / rect.width, y: (event.clientY - rect.top) * canvas.height / rect.height };
  };
  const start = event => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!context) return;
    canvas.setPointerCapture(event.pointerId);
    drawing.current = true;
    const p = point(event);
    context.beginPath();
    context.moveTo(p.x, p.y);
    context.lineTo(p.x + 0.1, p.y + 0.1);
    context.stroke();
  };
  const move = event => {
    if (!drawing.current) return;
    const context = canvasRef.current?.getContext('2d');
    if (!context) return;
    const p = point(event);
    context.lineTo(p.x, p.y);
    context.stroke();
  };
  const finish = () => {
    if (!drawing.current) return;
    drawing.current = false;
    onChange(canvasRef.current.toDataURL('image/png'));
  };
  const clear = () => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    onChange('');
  };
  return <div className="registration-signature">
    <div className="registration-signature-heading"><strong>{title}</strong><Button type="link" size="small" onClick={clear}>清除重签</Button></div>
    <canvas ref={canvasRef} width={840} height={220} onPointerDown={start} onPointerMove={move} onPointerUp={finish} onPointerCancel={finish} aria-label="请在此手写签名"/>
    <Typography.Text type="secondary">使用鼠标、触控板或手指签名。签名图与签署时间会留存。</Typography.Text>
  </div>;
}
