import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function environment() {
  const storage = new Map();
  const text = { nodeType:3, nodeValue:'经营总览', parentElement:{closest:() => false} };
  const input = {
    nodeType:1, childNodes:[], closest:() => false,
    values:{placeholder:'搜索'},
    getAttribute(key) { return this.values[key]; },
    setAttribute(key,value) { this.values[key] = value; }
  };
  const body = {nodeType:1, childNodes:[text,input], closest:() => false, getAttribute:() => null};
  const events = [];
  const context = vm.createContext({
    Node:{TEXT_NODE:3,ELEMENT_NODE:1},
    localStorage:{getItem:key => storage.get(key),setItem:(key,value) => storage.set(key,value)},
    document:{body,documentElement:{},getElementById:() => null},
    window:{dispatchEvent:event => events.push(event.type),location:{reload:() => {throw Error('must not reload');}}},
    Event:class {constructor(type) {this.type=type;}},
    MutationObserver:class {observe() {} takeRecords() {return [];}},
    queueMicrotask
  });
  const source = readFileSync(new URL('../src/i18n.js',import.meta.url),'utf8').replace(/export /g,'');
  vm.runInContext(source + `
    dictionary = {'经营总览':'Overview','数据报告':'Reports','搜索':'Search'};
    fragments = /经营总览|数据报告|搜索/g;
    globalThis.ui = {setLocale,translateNode};`,context);
  return {context,text,input,events,ui:context.ui};
}

test('language switches in place and reverses translated text and attributes',async () => {
  const {context,text,input,events,ui} = environment();
  for(let i=0;i<3;i++) {
    await ui.setLocale('en');
    assert.equal(text.nodeValue,'Overview');
    assert.equal(input.values.placeholder,'Search');
    assert.equal(context.document.documentElement.lang,'en');
    await ui.setLocale('zh');
    assert.equal(text.nodeValue,'经营总览');
    assert.equal(input.values.placeholder,'搜索');
  }
  assert.equal(events.length,6);
});

test('translations track subsequent UI updates and leave agreement text intact',async () => {
  const {text,ui} = environment();
  await ui.setLocale('en');
  text.nodeValue = '数据报告';
  ui.translateNode(text);
  assert.equal(text.nodeValue,'Reports');
  await ui.setLocale('zh');
  assert.equal(text.nodeValue,'数据报告');
  const legal = {nodeType:3,nodeValue:'经营总览',parentElement:{closest:() => true}};
  await ui.setLocale('en');
  ui.translateNode(legal);
  assert.equal(legal.nodeValue,'经营总览');
});
