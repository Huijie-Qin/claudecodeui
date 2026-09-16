import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('./index.html',import.meta.url),'utf8');
const ui=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)][1][1];
function section(a,b){const start=ui.indexOf(a),end=ui.indexOf(b,start);assert.ok(start>=0&&end>start);return ui.slice(start,end)}
const S={user:'lin',tenantId:'one',templates:[{id:'sales',tenantId:'one',title:'销售分析',description:'Orders report',fields:[],blocks:[]},{id:'weekly',tenantId:'one',title:'周报',description:'工作总结',fields:[],blocks:[]},{id:'private',tenantId:'two',title:'其他租户模板',description:'secret',fields:[],blocks:[]}],snippets:[{id:'sql',title:'SQL 规范',description:'查询检查',content:'LIMIT 100'},{id:'safe',title:'安全边界',description:'输入保护',content:'禁止访问生产凭据'}]};
const results={innerHTML:''},dialogResults={innerHTML:''},search={value:'',focus(){}},composer={value:'保留额外补充信息',focus(){}};
const ctx=vm.createContext({S,document:{getElementById(id){return id==='catalog-results'?results:id==='template-picker-results'?dialogResults:id==='chat-input'?composer:search}},route:'mine',selected:null,selectedPr:null,chatBusy:false,chatTemplateId:null,chatTemplateValues:{},chatBoundSkillId:null,
  M:{template(s,id){const t=s.templates.find(t=>t.id===id&&t.tenantId===s.tenantId);if(!t)throw Error('不可访问');return t}},discardBuffer:()=>true,render(){},modal:{open:true,close(){this.open=false}}});
vm.runInContext('const catalogQueries={templates:"",snippets:"",picker:""};const icon=()=>"";'+section('const esc=','const notice=')+section('function catalogSearchView(','function render()')+'function showDialog(title,body){globalThis.dialogBody=body;}globalThis.queries=catalogQueries;',ctx);
let count=0;function test(name,f){f();count++;console.log('PASS '+name)}
test('long template fields use full-width multiline controls and responsive columns',()=>{
 const chat=section('function chatView(){','function prView(');
 assert.match(chat,/f.kind==='textarea'\?`<textarea id="chat-field-/);
 assert.match(chat,/template-field-wide/);
 assert.match(html,/\.chat-template-fields \.template-field-wide\{grid-column:1\/-1\}/);
 assert.match(html,/\.chat-template-fields textarea\{min-height:80px;line-height:1\.6;resize:vertical\}/);
 assert.match(html,/\.chat-template-fields\{grid-template-columns:minmax\(0,1fr\)\}/);
});
test('icon-bearing search inputs share sufficient placeholder and text padding',()=>{
 assert.match(html,/\.search-wrap>\.ui-icon\{left:12px;width:16px;height:16px;pointer-events:none\}/);
 assert.match(html,/\.search-wrap>\.search\{padding-left:40px\}/);
 assert.match(html,/\.chat-input\{min-height:112px\}/);
 assert.ok(40-12-16>=12,'leave at least 12px between the icon and input text');
});
test('new Skill menu has direct and shared-template paths without premature navigation',()=>{
 const menu=section('function navigationView(){','function listView()');
 assert.match(menu,/新建技能方式/);assert.match(menu,/button\('直接创建','new'\)/);assert.match(menu,/button\('模板创建','chat-template-picker'\)/);
 assert.match(ui,/if\(a==='new'\|\|a==='upload'\)\{newDialog/);
 vm.runInContext('templatePickerDialog()',ctx);assert.equal(ctx.route,'mine');assert.match(ctx.dialogBody,/使用|选择模板/);assert.match(ctx.dialogBody,/data-catalog-search="picker"/);
});
test('catalog clear action is an in-field icon shown only when there is input',()=>{
 for(const scope of ['templates','snippets','picker']){
  ctx.queries[scope]='';
  const empty=vm.runInContext('catalogSearchView("'+scope+'")',ctx);
  assert.match(empty,/class="search-clear"[^>]* hidden>/);
  assert.doesNotMatch(empty,/>清空</);
  vm.runInContext('updateCatalogSearch("'+scope+'","文字")',ctx);
  assert.equal(search.hidden,false);
  const filled=vm.runInContext('catalogSearchView("'+scope+'")',ctx);
  assert.match(filled,/aria-label="清除搜索"/);
  assert.doesNotMatch(filled,/ hidden>/);
  vm.runInContext('updateCatalogSearch("'+scope+'","")',ctx);
  assert.equal(search.hidden,true);
 }
 assert.match(html,/\.catalog-search \.search\{[^}]*padding-right:44px/);
 const clearAction=section("if(a==='catalog-clear')", "if(a==='chat-template-select'");
 assert.match(clearAction,/input\.value='';input\.focus\(\)/);
});
test('all search surfaces trim keywords, match case-insensitively and respect scope',()=>{
 ctx.queries.templates=' orders ';assert.equal(vm.runInContext('catalogItems("templates")[0].id',ctx),'sales');
 ctx.queries.picker='secret';assert.equal(vm.runInContext('catalogItems("picker").length',ctx),0);
 ctx.queries.picker='周报';assert.equal(vm.runInContext('catalogItems("picker")[0].id',ctx),'weekly');
 ctx.queries.snippets='limit';assert.equal(vm.runInContext('catalogItems("snippets")[0].id',ctx),'sql');
 assert.equal(ctx.queries.templates,' orders ');
});
test('empty searches clear stale actions and updates preserve the original search input',()=>{
 vm.runInContext('updateCatalogSearch("picker","不存在")',ctx);assert.match(dialogResults.innerHTML,/没有匹配的模板/);assert.doesNotMatch(dialogResults.innerHTML,/data-action="chat-template-select"/);
 vm.runInContext('updateCatalogSearch("picker","")',ctx);assert.match(dialogResults.innerHTML,/chat-template-select/);assert.doesNotMatch(dialogResults.innerHTML,/其他租户模板/);
 assert.doesNotMatch(section('function updateCatalogSearch(','function templatePickerDialog('),/render\(|showDialog\(|\.focus\(/);
});
test('catalog search retains read-only role restrictions and escapes output',()=>{
 ctx.queries.templates='';assert.doesNotMatch(vm.runInContext('catalogResults("templates")',ctx),/template-edit/);
 ctx.queries.snippets='';assert.doesNotMatch(vm.runInContext('catalogResults("snippets")',ctx),/snippet-edit|snippet-delete/);
 S.user='admin';assert.match(vm.runInContext('catalogResults("snippets")',ctx),/snippet-edit/);
 ctx.queries.picker='"<script>';assert.match(vm.runInContext('catalogSearchView("picker")',ctx),/&quot;&lt;script&gt;/);
});
test('selection enters chat without generating and keeps supplemental input',()=>{
 vm.runInContext('function choose(a,id){'+section("if(a==='chat-template-select'||a==='template-use'){","if(a==='chat-template-clear')")+'}choose("chat-template-select","sales");',ctx);
 assert.equal(ctx.route,'chat');assert.equal(ctx.chatTemplateId,'sales');assert.equal(composer.value,'保留额外补充信息');assert.equal(ctx.modal.open,false);
 const select=section("if(a==='chat-template-select'||a==='template-use'){","if(a==='chat-template-clear')");assert.doesNotMatch(select,/startGeneration|newDialog/);
 ctx.chatBusy=true;assert.throws(()=>vm.runInContext('choose("chat-template-select","weekly")',ctx),/正在处理/);assert.equal(ctx.chatTemplateId,'sales');
});
console.log(count+' creation menu and catalog search checks passed. Prototype only.');
