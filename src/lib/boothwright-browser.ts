import { verifyOAuthQueryParams } from '@better-auth/oauth-provider';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { MarketKitOAuthConfig } from './marketkit-oauth-provider.js';
interface Options {
 enabled: boolean; baseURL?: string; secret?: string; config?: MarketKitOAuthConfig;
 auth?: { handler(request: Request): Promise<Response> };
}
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]!);
export function createBoothwrightBrowserHandler(o: Options) {
 if (o.enabled && (!o.auth || !o.secret || !o.baseURL || !o.config || o.config.loginPage !== '/login' || o.config.consentPage !== '/consent')) throw new Error('Dedicated browser requires provider, secret, issuer and exact /login /consent');
 const mac = (s: string) => createHmac('sha256', o.secret!).update('boothwright-browser-v1:'+s).digest('base64url');
 const seal = (v: unknown) => { const b = Buffer.from(JSON.stringify(v)).toString('base64url'); return b+'.'+mac(b); };
 const open = (s: string) => { const [b, sig] = s.split('.'); const expected = mac(b); if (!sig || sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) throw new Error(); return JSON.parse(Buffer.from(b,'base64url').toString()); };
 return async (request: Request): Promise<Response | null> => {
  if (!o.enabled) return null;
  const url = new URL(request.url);
  if (!['/login','/consent'].includes(url.pathname)) return null;
  const response = (body: string, status = 200, extra: Record<string,string> = {}) => new Response(body, { status, headers: { 'cache-control':'no-store', 'referrer-policy':'no-referrer', 'content-type':'text/html; charset=utf-8', 'content-security-policy':"default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", ...extra } });
  try {
   if (url.origin !== new URL(o.baseURL!).origin) return response('Invalid origin',400);
   let query = url.search.slice(1); let ticket: any; let decision: string | null = null;
   if (request.method === 'POST') {
    if (request.headers.get('origin') !== url.origin || !request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) return response('CSRF rejected',403);
    const form = new URLSearchParams(await request.text()); ticket = open(form.get('ticket') || '');
    if (ticket.exp < Date.now() || ticket.path !== url.pathname) return response('Expired request',400);
    const csrf = request.headers.get('cookie')?.split(';').map(x=>x.trim()).find(x=>x.startsWith('bw_csrf='))?.slice(8);
    if (csrf !== ticket.csrf) return response('CSRF rejected',403);
    query = ticket.query; decision = form.get('decision');
   } else if (request.method !== 'GET') return response('Method not allowed',405);
   if (!query || !await verifyOAuthQueryParams(query,o.secret!)) return response('Invalid continuation',400);
   const params = new URLSearchParams(query);
   // No unsigned additions/duplicate scalar parameters can influence our UI or redirects.
   const signed = new Set(params.getAll('ba_param'));
   for (const key of params.keys()) if (key !== 'sig' && !signed.has(key)) return response('Unsigned parameter',400);
   for (const key of ['client_id','redirect_uri','scope','response_type','code_challenge','code_challenge_method','exp','sig']) if (params.getAll(key).length > 1) return response('Duplicate parameter',400);
   if (params.get('client_id') !== o.config!.clientId || !o.config!.redirectUris.includes(params.get('redirect_uri') || '') || params.getAll('resource').length !== 1 || params.get('resource') !== o.config!.resource || params.get('response_type') !== 'code' || params.get('code_challenge_method') !== 'S256' || !params.get('code_challenge')) return response('Invalid authorization contract',400);
   const scopes = (params.get('scope') || '').split(' ').filter(Boolean);
   if (!scopes.length || scopes.some(s=>!o.config!.scopes.includes(s))) return response('Invalid scopes',400);
   const headers = new Headers({ cookie: request.headers.get('cookie') || '' });
   let session: any = null;
   if (url.pathname === '/consent') {
    const s = await o.auth!.handler(new Request(o.baseURL!+'/get-session', { headers }));
    session = await s.json(); if (!session?.session?.id) return response('Sign in required',401);
    if (ticket && ticket.session !== session.session.id) return response('Session changed',403);
   }
   if (request.method === 'GET') {
    const csrf = randomBytes(32).toString('base64url');
    const value = seal({ query, csrf, session: session?.session.id, path: url.pathname, exp: Date.now()+300000 });
    const buttons = url.pathname === '/login' ? '<button>Continue with Google</button>' : '<button name="decision" value="allow">Allow</button><button name="decision" value="deny">Deny</button>';
    return response(`<!doctype html><html lang="en"><title>Boothwright authorization</title><h1>Boothwright</h1><p>${escape(o.config!.clientName)}</p><p>Resource: ${escape(o.config!.resource)}</p><p>Scopes: ${escape(scopes.join(' '))}</p><form method="post" action="${url.pathname}"><input type="hidden" name="ticket" value="${escape(value)}">${buttons}</form></html>`,200, { 'set-cookie':`bw_csrf=${csrf}; HttpOnly; SameSite=Strict; Path=/; Max-Age=300${url.protocol === 'https:' ? '; Secure' : ''}` });
   }
   if (url.pathname === '/consent' && decision !== 'allow' && decision !== 'deny') return response('Explicit decision required',400);
   headers.set('content-type','application/json'); headers.set('origin',url.origin);
   const endpoint = url.pathname === '/login' ? '/sign-in/social' : '/oauth2/consent';
   const body = url.pathname === '/login' ? { provider:'google', oauth_query:query, callbackURL:o.baseURL!+'/oauth2/authorize?'+query, disableRedirect:true } : { accept:decision === 'allow', oauth_query:query };
   const result = await o.auth!.handler(new Request(o.baseURL!+endpoint,{method:'POST',headers,body:JSON.stringify(body)}));
   const data = await result.json() as { url?: string };
   if (!result.ok || !data.url) return response('Provider rejected request',400);
   const target = new URL(data.url, o.baseURL);
   if (url.pathname === '/login' ? target.origin !== 'https://accounts.google.com' : !o.config!.redirectUris.some(r=>target.origin === new URL(r).origin && target.pathname === new URL(r).pathname)) return response('Unsafe provider redirect',400);
   const redirect = response('',303,{location:target.toString()});
   for (const cookie of result.headers.getSetCookie()) redirect.headers.append('set-cookie', cookie);
   return redirect;
  } catch { return response('Invalid request',400); }
 };
}
