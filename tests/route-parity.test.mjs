import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

test('Go backend registers every Node API route', () => {
  const node = new Set();
  for (const file of ['server/index.mjs', 'server/gam-routes.mjs']) {
    for (const match of read(file).matchAll(/app\.(get|post|put|delete)\('([^']+)'/g)) {
      if (!match[2].startsWith('/api/')) continue;
      node.add(match[1].toUpperCase() + ' ' + match[2].replace(/:id\b/g, '{id}'));
    }
  }
  const go = new Set([...read('backend-go/main.go').matchAll(/mux\.HandleFunc\("(GET|POST|PUT|DELETE) (\/api\/[^\"]+)"/g)]
    .map(match => match[1] + ' ' + match[2]));
  assert.deepEqual([...node].filter(route => !go.has(route)).sort(), []);
});
