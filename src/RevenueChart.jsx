import React from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

export default function RevenueChart({ data, formatMoney }) {
  return <ResponsiveContainer><AreaChart data={data}>
    <defs><linearGradient id="revenue" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#168aad" stopOpacity={.35}/><stop offset="95%" stopColor="#168aad" stopOpacity={0}/></linearGradient></defs>
    <CartesianGrid strokeDasharray="3 3" vertical={false}/><XAxis dataKey="date"/><YAxis/>
    <Tooltip formatter={formatMoney}/><Area type="monotone" dataKey="revenue" stroke="#168aad" fill="url(#revenue)" strokeWidth={2}/>
  </AreaChart></ResponsiveContainer>;
}
