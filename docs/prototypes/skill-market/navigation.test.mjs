import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
const start=html.indexOf('function navigationView(){');
const end=html.indexOf('function listView()',start);
assert.ok(start>=0&&end>start);
const navigation={innerHTML:''},actions={innerHTML:''};
const ctx=vm.createContext({S:{user:'admin'},route:'admin',selected:null,selectedPr:null,
 navigation,document:{getElementById(id){assert.equal(id,'workspace-actions');return actions}},
 icon:()=>'',button:()=>''});
vm.runInContext(html.slice(start,end),ctx);
vm.runInContext('navigationView()',ctx);
assert.deepEqual([...navigation.innerHTML.matchAll(/data-id="([^"]+)"/g)].map(m=>m[1]),['market','mine','contributions','templates','admin']);
assert.match(navigation.innerHTML,/data-id="admin" aria-current="page">片段管理/);
assert.doesNotMatch(html,/<div id="admin-navigation">/);
for(const user of ['lin','chen','zhou']){
 ctx.S.user=user;ctx.route='market';vm.runInContext('navigationView()',ctx);
 assert.doesNotMatch(navigation.innerHTML,/data-id="admin"|片段管理/);
}
console.log('PASS snippet management follows templates in skill navigation, with admin-only visibility and no sidebar duplicate');
