import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { betterAuth as capturedBetterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { oauthProvider } from '@better-auth/oauth-provider';
import { createMarketKitOAuthProviderOptions } from '../../lib/marketkit-oauth-provider.js';

// Capture the production options without creating PostgreSQL connections. The
// Redis module is replaced ONLY with a client connected to our disposable socket.
const fixture = vi.hoisted(() => ({ redis: undefined as any }));
vi.mock('../../lib/redis.js', () => ({ redis: new Proxy({}, { get: (_, key) => {
  const value = fixture.redis[key];
  return typeof value === 'function' ? value.bind(fixture.redis) : value;
} }) }));
let directory: string;
let container: string;
let storage: any;
let realAuth: any;
const base = 'http://localhost:3002';
const redirect = 'https://mcp.marketkit.example/callback';
const resource = 'https://mcp.marketkit.example';

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'sar-1426-redis-'));
  execFileSync('chmod', ['777', directory]);
  container = execFileSync('docker', ['run', '-d', '--network', 'none', '-v', `${directory}:/fixture`, 'redis:7-alpine', 'redis-server', '--port', '0', '--save', '', '--appendonly', 'no', '--unixsocket', '/fixture/redis.sock', '--unixsocketperm', '777']).toString().trim();
  const { default: Redis } = await vi.importActual<typeof import('ioredis')>('ioredis');
  fixture.redis = new Redis({ path: join(directory, 'redis.sock'), lazyConnect: true, retryStrategy: () => 20 });
  await fixture.redis.connect();
  await import('../../lib/auth.js');
  storage = vi.mocked(capturedBetterAuth).mock.calls.at(-1)![0].secondaryStorage;
  const { betterAuth } = await vi.importActual<typeof import('better-auth')>('better-auth');
  const { jwt } = await vi.importActual<typeof import('better-auth/plugins')>('better-auth/plugins');
  const db: Record<string, any[]> = Object.fromEntries(['user','users','session','sessions','account','accounts','verification','verifications','jwks','oauthClient','oauthResource','oauthClientResource','oauthRefreshToken','oauthAccessToken','oauthConsent','oauthClientAssertion'].map(k => [k, []]));
  db.oauthClient.push({ id:'client', clientId:'redis-client', name:'Redis fixture', redirectUris:[redirect], scopes:['mcp:tools'], requirePKCE:true, skipConsent:true, tokenEndpointAuthMethod:'none', grantTypes:['authorization_code'], responseTypes:['code'], disabled:false, createdAt:new Date(), updatedAt:new Date() });
  db.oauthResource.push({id:'resource',identifier:resource,name:'Fixture',allowedScopes:['mcp:tools'],disabled:false,createdAt:new Date(),updatedAt:new Date()});
  db.oauthClientResource.push({id:'link',clientId:'redis-client',resourceId:resource,createdAt:new Date()});
  realAuth = betterAuth({ database:memoryAdapter(db), secondaryStorage:storage, baseURL:base, basePath:'/', secret:'k'.repeat(48), emailAndPassword:{enabled:true}, session:{storeSessionInDatabase:true}, plugins:[jwt({jwks:{keyPairConfig:{alg:'RS256'}}}),oauthProvider(createMarketKitOAuthProviderOptions({clientId:'redis-client',clientName:'Fixture',redirectUris:[redirect],allowedOrigins:['https://mcp.marketkit.example'],resource,scopes:['mcp:tools'],consentPage:'/consent',loginPage:'/login'}))] });
}, 30000);
afterAll(async () => {
  fixture.redis?.disconnect();
  if (container) execFileSync('docker', ['rm', '-f', container]);
  if (directory) rmSync(directory, { recursive:true, force:true });
});

it('allows exactly one concurrent consumer of a Redis-backed single-use value', async () => {
  await storage.set('single-use', 'value', 60);
  const values = await Promise.all(Array.from({length:32}, () => storage.getAndDelete('single-use')));
  expect(values.filter(v => v === 'value')).toHaveLength(1);
  expect(values.filter(v => v === null)).toHaveLength(31);
  expect(await storage.get('single-use')).toBeNull();
});
it('returns null for missing and expired values', async () => {
  expect(await storage.getAndDelete('missing')).toBeNull();
  await storage.set('expired', 'value', 60);
  await fixture.redis.pexpire('expired', 1);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(await storage.getAndDelete('expired')).toBeNull();
});
it('rejects concurrent OAuth double redemption through actual Redis secondary storage', async () => {
  const signup = await realAuth.handler(new Request(`${base}/sign-up/email`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'redis@fixture.example',password:'Passw0rd!Passw0rd!!',name:'Fixture'})}));
  expect(signup.status).toBe(200);
  const cookie = signup.headers.getSetCookie().map((v:string) => v.split(';')[0]).join('; ');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const query = new URLSearchParams({client_id:'redis-client',redirect_uri:redirect,response_type:'code',scope:'mcp:tools',resource,code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'});
  const authorized = await realAuth.handler(new Request(`${base}/oauth2/authorize?${query}`, {headers:{cookie}}));
  expect(authorized.status).toBe(302);
  const code = new URL(authorized.headers.get('location')!).searchParams.get('code')!;
  expect(code).toBeTruthy();
  const redeem = () => realAuth.handler(new Request(`${base}/oauth2/token`, {method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code,client_id:'redis-client',redirect_uri:redirect,resource,code_verifier:verifier})}));
  const responses = await Promise.all([redeem(), redeem()]);
  expect(responses.map(r => r.status).sort()).toEqual([200,400]);
  expect(await responses.find(r => r.status === 400)!.json()).toMatchObject({error:'invalid_grant'});
  expect((await redeem()).status).toBe(400);
});
