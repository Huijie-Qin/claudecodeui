import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
const start=html.indexOf('function navigationView(){');
const end=html.indexOf('function listView()',start);
assert.ok(start>=0&&end>start);
const navigation={innerHTML:''},actions={innerHTML:''},toolbar={hidden:false},prototypeStrip={hidden:false};
const classList={toggle(){}};
const topElements={'workspace-actions':actions,'workspace-chat-tab':{classList,toggleAttribute(){}},'workspace-skill-tab':{classList,toggleAttribute(){}},'workspace-page-title':{textContent:''}};
const ctx=vm.createContext({S:{user:'admin'},route:'admin',selected:null,selectedPr:null,
 navigation,document:{getElementById(id){assert.ok(topElements[id]);return topElements[id]},querySelector(selector){if(selector==='.skill-toolbar')return toolbar;if(selector==='.prototype-strip')return prototypeStrip;assert.fail(`unexpected selector ${selector}`)}},
 icon:()=>'',button:()=>''});
vm.runInContext(html.slice(start,end),ctx);
vm.runInContext('navigationView()',ctx);
assert.deepEqual([...navigation.innerHTML.matchAll(/data-id="([^"]+)"/g)].map(m=>m[1]),['market','mine','contributions','templates','admin']);
assert.match(navigation.innerHTML,/data-id="admin" aria-current="page">片段管理/);
assert.doesNotMatch(html,/<div id="admin-navigation">/);
ctx.route='chat';vm.runInContext('navigationView()',ctx);
assert.equal(toolbar.hidden,true);
assert.equal(prototypeStrip.hidden,true);
for(const user of ['lin','chen','zhou']){
 ctx.S.user=user;ctx.route='market';vm.runInContext('navigationView()',ctx);
 assert.match(navigation.innerHTML,/data-id="admin".*片段管理/);
}
console.log('PASS snippet management follows templates in skill navigation, with read-only visibility for ordinary users and no sidebar duplicate');
