import test from 'node:test';
import assert from 'node:assert/strict';
import {handle, eventFor, isPrivateFileProbe} from '../src/index.js';

function setup({mode='enforce',rule=null,rate=true,enabled=1,failWrite=false}={}) {
  const events=[]; let forwarded=0; let limited=0;
  const env={SERVICE_HOST:'guard.example.workers.dev', DB:{prepare(sql){return {
    values:[],bind(...v){this.values=v;return this;},
    async first(){if(sql==='SELECT 1')return {1:1};return sql.includes('FROM domains')?{mode,enabled}:rule;},
    async run(){if(failWrite)throw Error('storage');events.push(this.values);}
  };}},PAGE_RATE:{async limit(){limited++;return {success:rate};}}};
  const origin=async()=>{forwarded++;return new Response('original',{status:200});};
  return {env,events,origin,get forwarded(){return forwarded;},get limited(){return limited;}};
}
function req(path='/',cf={}) {
  const r=new Request(`https://example.com${path}`,{headers:{'accept':'text/html','cf-connecting-ip':'192.0.2.1','user-agent':'Mozilla/5.0 Mobile'}});
  Object.defineProperty(r,'cf',{value:cf}); return r;
}
test('ordinary visitors pass without persisting an IP',async()=>{
  const s=setup();assert.equal((await handle(req(),s.env,{},s.origin)).status,200);assert.equal(s.events.length,0);
});
test('rate exceeded: 429, durable event, no origin request',async()=>{
  const s=setup({rate:false});const r=await handle(req(),s.env,{},s.origin);
  assert.equal(r.status,429);assert.equal(r.headers.get('retry-after'),'60');assert.equal(s.events.length,1);assert.equal(s.forwarded,0);
});
test('observation records evidence without blocking',async()=>{
  const s=setup({mode:'observe',rate:false});assert.equal((await handle(req(),s.env,{},s.origin)).status,200);
  assert.ok(s.events[0].includes('would_block'));
});
test('verified bots bypass navigation rate; UA claim alone does not',async()=>{
  const s=setup({rate:false});assert.equal((await handle(req('/',{botManagement:{verifiedBot:true}}),s.env,{},s.origin)).status,200);assert.equal(s.limited,0);
});
test('manual allow overrides rate, manual block persists evidence',async()=>{
  const a=setup({rate:false,rule:{action:'allow'}});assert.equal((await handle(req(),a.env,{},a.origin)).status,200);
  const b=setup({rule:{action:'block',reason:'confirmed abuse'}});assert.equal((await handle(req(),b.env,{},b.origin)).status,403);assert.equal(b.events.length,1);
});
test('private-file probing is blocked, ordinary paths are not',async()=>{
  const s=setup();assert.equal((await handle(req('/.git/config'),s.env,{},s.origin)).status,403);
  assert.equal(isPrivateFileProbe('/environment'),false);
});
test('logging omits query, cookies and authorization',()=>{
  const r=req('/landing?email=secret&fbclid=secret',{country:'BR',asn:64500});
  r.headers.set('cookie','session=secret');r.headers.set('authorization','Bearer secret');
  const e=eventFor(r,'blocked','test');assert.equal(e.country,'BR');assert.equal(e.device,'mobile');assert.ok(!JSON.stringify(e).includes('secret'));
});
test('disabled host passes through',async()=>{
  const s=setup({enabled:0,rate:false});assert.equal((await handle(req(),s.env,{},s.origin)).status,200);assert.equal(s.limited,0);
});
test('standalone worker exposes no log endpoint',async()=>{
  const s=setup();const r=await handle(new Request('https://guard.example.workers.dev/logs'),s.env,{},s.origin);
  assert.equal(r.status,404);assert.equal(s.forwarded,0);
});
