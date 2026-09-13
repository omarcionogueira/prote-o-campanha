export function deviceFromUA(ua) {
  if (/ipad|tablet/i.test(ua)) return 'tablet';
  if (/mobile|android|iphone|ipod/i.test(ua)) return 'mobile';
  return ua ? 'desktop_or_other' : 'unknown';
}

export function isDocument(request) {
  return request.method === 'GET' && (
    request.headers.get('sec-fetch-dest') === 'document' ||
    (request.headers.get('accept') || '').includes('text/html')
  );
}

export function isPrivateFileProbe(path) {
  // Deliberately narrow: no ad-reviewer, country, browser or model exclusions.
  return /^\/\.git(?:\/|$)/i.test(path) || /^\/\.env(?:\.[a-z0-9_-]+)?$/i.test(path);
}

export function eventFor(request, action, reason) {
  const url = new URL(request.url);
  const cf = request.cf || {};
  const ua = (request.headers.get('user-agent') || '').slice(0, 512);
  return {
    id: crypto.randomUUID(), timestamp: Date.now(), hostname: url.hostname,
    ip: request.headers.get('cf-connecting-ip') || '',
    country: cf.country || null, region: cf.region || null, city: cf.city || null,
    asn: Number.isFinite(cf.asn) ? cf.asn : null,
    network: cf.asOrganization || null, device: deviceFromUA(ua), user_agent: ua,
    path: url.pathname.slice(0, 512), method: request.method, action, reason,
    ray: request.headers.get('cf-ray') || null,
    verified_bot: cf.botManagement?.verifiedBot === true ? 1 : 0,
    bot_score: Number.isFinite(cf.botManagement?.score) ? cf.botManagement.score : null
  };
}

export async function saveEvent(db, event) {
  const keys = Object.keys(event);
  await db.prepare(`INSERT INTO events (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .bind(...Object.values(event)).run();
}

function denied(status, id, retry = false) {
  return new Response(`Acesso temporariamente indisponível. Referência: ${id}`, {
    status, headers: {
      'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', ...(retry ? {'retry-after': '60'} : {})
    }
  });
}

export async function handle(request, env, ctx, originFetch = fetch) {
  const url = new URL(request.url);
  // Standalone endpoint is only a health check; no public logs/admin or open proxy.
  if (url.hostname === env.SERVICE_HOST) {
    if (url.pathname !== '/health' || request.method !== 'GET') return new Response('Not found', {status:404});
    try {
      await env.DB.prepare('SELECT 1').first();
      return Response.json({service:'cerberus-traffic-guard', status:'ready', version:1}, {headers:{'cache-control':'no-store'}});
    } catch { return new Response('Storage unavailable', {status:503}); }
  }
  let domain;
  let rule;
  const ip = request.headers.get('cf-connecting-ip') || '';
  try {
    domain = await env.DB.prepare('SELECT mode, enabled FROM domains WHERE hostname = ?').bind(url.hostname).first();
    if (!domain || !domain.enabled) return originFetch(request);
    rule = await env.DB.prepare('SELECT action, reason FROM ip_rules WHERE hostname = ? AND ip = ? AND expires_at > ?')
      .bind(url.hostname, ip, Date.now()).first();
  } catch {
    // Outages should not turn into permanent false-positive IP bans.
    console.error(JSON.stringify({type:'guard_storage_unavailable', hostname:url.hostname}));
    return originFetch(request);
  }
  let reason = '';
  let status = 403;
  if (rule?.action === 'block') reason = `reviewed_ip:${rule.reason}`;
  else if (rule?.action !== 'allow') {
    if (isPrivateFileProbe(url.pathname)) reason = 'private_file_probe';
    else if (isDocument(request) && ip && request.cf?.botManagement?.verifiedBot !== true) {
      try {
        if (!(await env.PAGE_RATE.limit({key:`${url.hostname}:${ip}`})).success) {
          reason = 'navigation_rate_exceeded'; status = 429;
        }
      } catch { console.error(JSON.stringify({type:'guard_rate_unavailable', hostname:url.hostname})); }
    }
  }
  if (!reason) return originFetch(request);
  const blocked = domain.mode === 'enforce';
  const event = eventFor(request, blocked ? 'blocked' : 'would_block', reason);
  try { await saveEvent(env.DB, event); }
  catch {
    // Metadata fallback in Workers Logs; D1 persistence is not claimed on failure.
    console.error(JSON.stringify({type:'guard_event_write_failed', event}));
  }
  if (blocked) return denied(status, event.id, status === 429);
  return originFetch(request);
}

export default {fetch: handle};
