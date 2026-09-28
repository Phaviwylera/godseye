import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const api = runInNewContext(readFileSync(new URL('../js/saved-views.js',import.meta.url),'utf8')+'\nSavedViews;');
const view = {name:'Chennai',center:[80.2,13.1],zoom:10,pitch:30,bearing:0};
test('saved views validate coordinates and recover corrupt storage',()=>{
  assert.ok(api.valid(view));
  assert.ok(!api.valid({...view,center:[999,0]}));
  assert.ok(!api.valid({...view,zoom:Infinity}));
  assert.equal(api.read({getItem:()=>'{broken'}).length,0);
  assert.equal(api.read({getItem:()=>JSON.stringify([view,{}])}).length,1);
  assert.equal(api.read({getItem:()=>JSON.stringify(Array(20).fill(view))}).length,12);
});
