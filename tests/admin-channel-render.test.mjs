import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { build } from 'esbuild';

test('channel management renders contract review without a missing component', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const output = path.join(root, 'node_modules', '.adx-channel-render-' + process.pid + '.mjs');
  try {
    await build({
      absWorkingDir: root, entryPoints: ['src/AdminPages.jsx'], bundle: true,
      platform: 'node', format: 'esm', packages: 'external', loader: { '.css': 'empty' },
      outfile: output
    });
    const { default: AdminPages } = await import(pathToFileURL(output).href);
    const html = renderToString(React.createElement(AdminPages, {
      view: 'channels', user: { id: 1, name: 'Admin', email: 'admin@example.test', role: 'admin' }
    }));
    assert.match(html, /渠道注册与合同审核/);
  } finally {
    fs.rmSync(output, { force: true });
  }
});
