import { promises as fs } from 'node:fs';
import path from 'node:path';
const { chromium } = await import(process.env.HOOK_AUDIT_PLAYWRIGHT || 'playwright');
const control = process.env.HOOK_AUDIT_CONTROL || 'http://127.0.0.1:4462';
async function api(route) {
  const response = await fetch(control + route);
  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data));
  return data;
}
const state = await api('/state');
const selected = process.argv[2]?.split(',');
const variant = process.env.HOOK_AUDIT_RUN_LABEL || '';
const cases = state.cases.filter(c => !selected || selected.includes(c.id));
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.HOOK_AUDIT_CHROME || undefined });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await context.addInitScript(({token,tenantId}) => {
  localStorage.setItem('auth-token', token);
  localStorage.setItem('currentTenantId', String(tenantId));
  window.__auditEvents = [];
  window.__auditSockets = [];
  const Original = window.WebSocket;
  window.WebSocket = class extends Original {
    constructor(...args) {
      super(...args);
      window.__auditSockets.push(this);
      this.addEventListener('message', event => {
        try { window.__auditEvents.push({at:Date.now(),message:JSON.parse(event.data)}); } catch {}
      });
    }
    send(data) {
      try { window.__auditEvents.push({at:Date.now(),sent:JSON.parse(data)}); } catch {}
      return super.send(data);
    }
  };
}, state);
const summary = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
for (const c of cases) {
  const dir = path.join(state.root, c.id + (variant ? '-'+variant : ''));
  await fs.mkdir(dir, {recursive:true});
  const result = {id:c.id, variant, startedAt:new Date().toISOString(), samples:[], screenshots:[], errors:[]};
  const page = await context.newPage();
  page.on('pageerror', e => result.errors.push(e.message));
  let events = [];
  let sessionId;
  const capture = async name => {
    await page.screenshot({path:path.join(dir, name+'.png'), fullPage:true});
    await fs.writeFile(path.join(dir,name+'.txt'),await page.locator('body').innerText());
    result.screenshots.push(name+'.png');
  };
  const snapshot = async () => page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button')].filter(b => b.getBoundingClientRect().height > 0);
    const stop = buttons.find(b => /STOP/.test(b.innerText));
    return {at:Date.now(), running:Boolean(stop), status:stop?.parentElement?.parentElement?.innerText || '',
      buttons:buttons.map(b => b.innerText.trim()).filter(Boolean), events:window.__auditEvents || []};
  });
  const status = async () => {
    if (!sessionId) return null;
    const before = await page.evaluate(() => window.__auditEvents.length);
    await page.evaluate(sid => {
      const ws=window.__auditSockets.find(s=>s.url.includes('/ws?') && s.readyState===1);
      ws?.send(JSON.stringify({type:'check-session-status',sessionId:sid,provider:'claude'}));
      ws?.send(JSON.stringify({type:'get-active-sessions',requestId:'audit-'+Date.now()}));
    },sessionId);
    await sleep(200);
    return (await snapshot()).events.slice(before).filter(e=>['session-status','active-sessions'].includes(e.message?.type));
  };
  try {
    await api('/activate?id='+c.id);
    await page.goto(state.ui, {waitUntil:'domcontentloaded'});
    await page.locator('textarea').waitFor({state:'visible',timeout:30000});
    await page.locator('textarea').fill('AUDIT_CASE '+c.id+' 请完成本轮测试。');
    await page.locator('textarea').press('Enter');
    let capturedRunning=false, interacted=false, reloaded=false, completedAt=null;
    const began=Date.now();
    while(Date.now()-began < Number(process.env.HOOK_AUDIT_OBSERVE_MS || 45000)) {
      const s=await snapshot();
      events=s.events;
      const incoming=events.filter(e=>e.message);
      sessionId ||= incoming.find(e=>e.message.sessionId && !e.message.sessionId.startsWith('pending'))?.message.sessionId;
      result.samples.push({at:s.at,running:s.running,status:s.status});
      const hookRunning=incoming.some(e=>e.message.kind==='hook_activity' && e.message.status==='running');
      if (!capturedRunning && s.running && (hookRunning || c.id==='baseline')) {
        await capture('running'); capturedRunning=true; result.duringStatus=await status();
      }
      if (!interacted && ['allow','deny'].includes(c.interaction) && s.buttons.some(b=>b==='确定执行')) {
        await capture('confirmation-wait');result.confirmationStatus=await status();
        await sleep(1500);
        await page.getByRole('button',{name:c.interaction==='allow'?'确定执行':'取消调用',exact:true}).click();
        interacted=true;
      }
      const loopRunning=incoming.some(e=>e.message.loopJobId && ['queued','running'].includes(e.message.loopStatus));
      if (loopRunning && !interacted && c.interaction==='abort') {
        await capture('loop-wait');result.loopStatus=await status();
        await page.getByRole('button',{name:/STOP/}).click();interacted=true;
      }
      if (loopRunning && !interacted && c.interaction==='cancel-loop') {
        const cancel=page.getByRole('button',{name:/取消等待|Cancel wait/});
        if(await cancel.count()) {await capture('loop-wait');result.loopStatus=await status();await cancel.first().click();interacted=true;}
      }
      if(loopRunning && c.id==='loop_reload' && !reloaded) {
        await capture('before-reload');result.beforeReloadEvents=events;
        await page.reload({waitUntil:'domcontentloaded'});await page.locator('textarea').waitFor({state:'visible'});
        await sleep(700);await capture('after-reload');reloaded=true;
      }
      const completion=incoming.find(e=>e.message.kind==='complete' && !e.message.suspended);
      if(completion) {completedAt=completion.at;break;}
      await sleep(120);
    }
    result.sessionId=sessionId;
    result.completedAt=completedAt;
    result.interacted=interacted;
    await sleep(1200);
    await capture('final');
    const expand=page.getByRole('button',{name:/展开执行过程|Expand execution process/});
    for (let i=0;i<await expand.count();i++) await expand.nth(i).click().catch(()=>{});
    if(await page.getByRole('button',{name:/收起执行过程|Collapse execution process/}).count()) await capture('expanded');
    result.finalStatus=await status();
    let s=await snapshot();result.runningAfterEnd=s.running;events=s.events;
    result.finalBody=await page.locator('body').innerText();
    if(!completedAt) {
      result.timedOut=true;
      const stop=page.getByRole('button',{name:/STOP/});
      if(await stop.count()) {await stop.click();await sleep(1500);result.afterAbortStatus=await status();await capture('after-abort');}
    }
    await api('/disable');
    // A same-session human probe proves whether output is retained in model context.
    if(completedAt && !result.runningAfterEnd && c.id!=='loop_abort') {
      result.probeStart=Date.now();
      await page.locator('textarea').fill('AUDIT_PROBE 请简短确认。');
      await page.locator('textarea').press('Enter');
      const deadline=Date.now()+20000;
      while(Date.now()<deadline) {
        s=await snapshot();
        if(s.events.some(e=>e.at>=result.probeStart && e.message?.kind==='complete' && !e.message.suspended)) break;
        await sleep(150);
      }
      await sleep(400);events=(await snapshot()).events;
    }
    const evidence=await api('/evidence?sessionId='+encodeURIComponent(sessionId||''));
    delete evidence.modelRequests;
    await fs.writeFile(path.join(dir,'database.json'),JSON.stringify(evidence,null,2));
    result.mainCount=evidence.mainCount;result.reviewCount=evidence.reviewCount;
    result.hookStatuses=evidence.executions.map(e=>e.status);
    result.hookCount=evidence.executions.length;
  } catch(error) {
    result.failure=error.stack;
    await capture('error').catch(()=>{});
    events=(await snapshot().catch(()=>({events}))).events;
  } finally {
    await fs.writeFile(path.join(dir,'events.json'),JSON.stringify(events,null,2));
    await fs.writeFile(path.join(dir,'result.json'),JSON.stringify(result,null,2));
    summary.push(result);
    await fs.writeFile(path.join(state.root,'browser-summary-'+(selected?'subset':'all')+(variant?'-'+variant:'')+'.json'),JSON.stringify(summary,null,2));
    console.log(JSON.stringify({id:c.id,sessionId,completed:Boolean(result.completedAt),runningAfterEnd:result.runningAfterEnd,mainCount:result.mainCount,reviewCount:result.reviewCount,hookCount:result.hookCount,failure:result.failure?.slice(0,150)}));
    await page.close();
  }
}
await browser.close();
