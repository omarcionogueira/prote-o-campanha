import fs from 'node:fs/promises';
import {isIP} from 'node:net';
import {fileURLToPath} from 'node:url';
const root = fileURLToPath(new URL('.', import.meta.url));
const account = process.env.CLOUDFLARE_ACCOUNT_ID || 'eaa63fcf92ad88795146e63ac2f96b42';
const name = 'cerberus-traffic-guard';
const headers = process.env.CLOUDFLARE_API_TOKEN
  ? {Authorization:`Bearer ${process.env.CLOUDFLARE_API_TOKEN}`}
  : {'X-Auth-Key':process.env.CLOUDFLARE_API_KEY, 'X-Auth-Email':process.env.CLOUDFLARE_EMAIL};
if (!process.env.CLOUDFLARE_API_TOKEN && (!process.env.CLOUDFLARE_API_KEY || !process.env.CLOUDFLARE_EMAIL)) {
  throw Error('Set CLOUDFLARE_API_TOKEN or CLOUDFLARE_API_KEY + CLOUDFLARE_EMAIL in the process environment.');
}
async function api(path, method='GET', body) {
  const multipart=body instanceof FormData;
  const response=await fetch(`https://api.cloudflare.com/client/v4/${path}`, {
    method, headers:{...headers,...(body && !multipart ? {'Content-Type':'application/json'} : {})},
    body:body ? multipart ? body : JSON.stringify(body) : undefined,
    signal:AbortSignal.timeout(60000)
  });
  const data=await response.json();
  if (!response.ok || !data.success) throw Error(`${method} ${path}: ${response.status} ${JSON.stringify(data.errors)}`);
  return data.result;
}
const prefix=`accounts/${account}`;
const statePath=`${root}deployment.json`;
async function state(){return JSON.parse(await fs.readFile(statePath,'utf8'));}
async function query(sql,params=[]) {
  const s=await state();
  if(s.account_id!==account)throw Error('Account differs from deployment state.');
  const results=await api(`${prefix}/d1/database/${s.database_id}/query`,'POST',{sql,params});
  if(results.some(x=>x.success===false))throw Error('D1 statement failed');
  return results;
}
function host(input){
  if(!input || !/^[a-z0-9.-]+$/i.test(input) || !input.includes('.'))throw Error('Supply an exact hostname, without scheme or path.');
  return input.toLowerCase();
}
async function zoneFor(hostname){
  const zones=await api(`zones?account.id=${account}&per_page=50`);
  const zone=zones.filter(z=>hostname===z.name || hostname.endsWith(`.${z.name}`)).sort((a,b)=>b.name.length-a.name.length)[0];
  if(!zone)throw Error('Hostname is not in this account.');return zone;
}
const [command,arg,arg2,arg3,arg4]=process.argv.slice(2);
if(command==='deploy'){
  let existing;
  try{existing=await state();}catch(e){if(e.code!=='ENOENT')throw e;}
  const scripts=await api(`${prefix}/workers/scripts`);
  if(scripts.some(s=>s.id===name) && !existing)throw Error('Worker already exists without local ownership state. Refusing overwrite.');
  const databases=await api(`${prefix}/d1/database?per_page=100`);
  let db=databases.find(d=>d.name===`${name}-logs`);
  if(!db)db=await api(`${prefix}/d1/database`,'POST',{name:`${name}-logs`});
  const sub=await api(`${prefix}/workers/subdomain`);
  const serviceHost=`${name}.${sub.subdomain}.workers.dev`;
  await fs.writeFile(statePath,JSON.stringify({account_id:account,worker:name,database_id:db.uuid,service_host:serviceHost},null,2)+'\n');
  await query(await fs.readFile(`${root}schema.sql`,'utf8'));
  const form=new FormData();
  form.append('metadata',JSON.stringify({main_module:'index.js',compatibility_date:'2026-09-13',
    bindings:[{type:'d1',name:'DB',id:db.uuid},{type:'plain_text',name:'SERVICE_HOST',text:serviceHost},
      {type:'ratelimit',name:'PAGE_RATE',namespace_id:'944080131',simple:{limit:120,period:60}}],
    observability:{enabled:true,head_sampling_rate:1,logs:{enabled:true,invocation_logs:false}}
  }));
  form.append('index.js',new Blob([await fs.readFile(`${root}src/index.js`,'utf8')],{type:'application/javascript+module'}),'index.js');
  const deployed=await api(`${prefix}/workers/scripts/${name}`,'PUT',form);
  await api(`${prefix}/workers/scripts/${name}/subdomain`,'POST',{enabled:true,previews_enabled:false});
  console.log(JSON.stringify({worker:name,health:`https://${serviceHost}/health`,database_id:db.uuid,deployment_id:deployed.deployment_id}));
}else if(command==='inspect'){
  const hostname=host(arg);const zone=await zoneFor(hostname);
  const dns=await api(`zones/${zone.id}/dns_records?name=${encodeURIComponent(hostname)}&per_page=100`);
  const routes=await api(`zones/${zone.id}/workers/routes`);
  const custom=await api(`${prefix}/workers/domains?zone_id=${zone.id}`);
  console.log(JSON.stringify({zone:zone.name,hostname,dns:dns.map(d=>({name:d.name,type:d.type,proxied:d.proxied})),routes,custom},null,2));
}else if(command==='activate'){
  const hostname=host(arg);const mode=arg2 || 'observe';
  if(!['observe','enforce'].includes(mode))throw Error('Mode must be observe or enforce');
  const zone=await zoneFor(hostname);
  const dns=await api(`zones/${zone.id}/dns_records?name=${encodeURIComponent(hostname)}&per_page=100`);
  if(!dns.some(r=>r.proxied && ['A','AAAA','CNAME'].includes(r.type)))throw Error('Requires an existing proxied DNS record.');
  const routes=await api(`zones/${zone.id}/workers/routes`);
  const custom=await api(`${prefix}/workers/domains?zone_id=${zone.id}`);
  if(custom.some(d=>d.hostname===hostname))throw Error('Existing Worker custom domain; integration requires review.');
  const overlaps=routes.filter(r=>{
    const pattern=r.pattern.replace(/^https?:\/\//,'');
    const routeHost=pattern.split('/')[0];
    const re=new RegExp('^'+routeHost.split('*').map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*')+'$');
    return re.test(hostname);
  });
  if(overlaps.some(r=>r.script!==name))throw Error('Existing route would overlap; refusing to override.');
  await query('INSERT INTO domains(hostname,mode,enabled,updated_at) VALUES(?,?,1,?) ON CONFLICT(hostname) DO UPDATE SET mode=excluded.mode,enabled=1,updated_at=excluded.updated_at',[hostname,mode,Date.now()]);
  if(!overlaps.some(r=>r.pattern===`${hostname}/*` && r.script===name))await api(`zones/${zone.id}/workers/routes`,'POST',{pattern:`${hostname}/*`,script:name});
  console.log(JSON.stringify({hostname,mode,active:true}));
}else if(command==='logs'){
  const hostname=host(arg);
  console.log(JSON.stringify(await query('SELECT * FROM events WHERE hostname=? ORDER BY timestamp DESC LIMIT 100',[hostname]),null,2));
}else if(command==='candidates'){
  const hostname=host(arg);
  console.log(JSON.stringify(await query('SELECT ip,country,reason,COUNT(*) AS hits,MIN(timestamp) AS first_seen,MAX(timestamp) AS last_seen FROM events WHERE hostname=? AND timestamp>=? GROUP BY ip,country,reason ORDER BY hits DESC LIMIT 100',[hostname,Date.now()-7*86400000]),null,2));
}else if(command==='block' || command==='allow'){
  const hostname=host(arg);if(!isIP(arg2))throw Error('Valid individual IP required.');
  const hours=Number(arg3 || 24);if(!Number.isFinite(hours)||hours<=0||hours>720)throw Error('Duration: 1 to 720 hours.');
  if(!arg4 || arg4.length>200)throw Error('Supply a reviewed reason, max 200 characters.');
  await query('INSERT INTO ip_rules(hostname,ip,action,reason,expires_at,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(hostname,ip) DO UPDATE SET action=excluded.action,reason=excluded.reason,expires_at=excluded.expires_at',[hostname,arg2,command,arg4,Date.now()+hours*3600000,Date.now()]);
  console.log('Rule saved with expiration.');
}else if(command==='unblock'){
  await query('DELETE FROM ip_rules WHERE hostname=? AND ip=?',[host(arg),arg2]);console.log('Rule removed.');
}else if(command==='disable'){
  await query('UPDATE domains SET enabled=0,updated_at=? WHERE hostname=?',[Date.now(),host(arg)]);console.log('Filtering disabled; origin passes through.');
}else throw Error('Commands: deploy | inspect HOST | activate HOST [observe|enforce] | logs HOST | candidates HOST | block/allow HOST IP HOURS REASON | unblock HOST IP | disable HOST');
