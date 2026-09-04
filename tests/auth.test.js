import assert from 'node:assert/strict';
import test from 'node:test';
import { AccountStore, createAuthGuard, getBearerToken, InMemoryAccountStore, issueToken, issueTokenPair, protect, refreshAccessToken, verifyToken } from '../src/auth/index.js';

const secret = 'test-secret-that-is-long-enough-for-hmac';

test('rejects JWT secrets shorter than 32 characters', () => {
  assert.throws(
    () => issueToken({ subject: 'user-1', secret: 'a'.repeat(31) }),
    /JWT secret is required/
  );
});

test('issues and verifies JWT access tokens', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const token = issueToken({
    subject: 'user-1',
    roles: ['member'],
    permissions: ['profile:read'],
    secret,
    issuer: 'platform-shared',
    audience: 'social',
    now
  });

  const payload = verifyToken(token, {
    secret,
    issuer: 'platform-shared',
    audience: 'social',
    now: new Date('2026-01-01T00:01:00Z'),
    expectedUse: 'access'
  });

  assert.equal(payload.sub, 'user-1');
  assert.deepEqual(payload.roles, ['member']);
  assert.deepEqual(payload.permissions, ['profile:read']);
});

test('refreshes access tokens from refresh tokens', () => {
  const pair = issueTokenPair({ subject: 'user-2', roles: ['admin'], permissions: ['notifications:send'], secret });
  const refreshed = refreshAccessToken(pair.refreshToken, { secret, accessTokenTtlSeconds: 60 });
  const payload = verifyToken(refreshed, { secret, expectedUse: 'access' });

  assert.equal(payload.sub, 'user-2');
  assert.deepEqual(payload.permissions, ['notifications:send']);
});

test('guard authenticates bearer tokens and enforces RBAC', async () => {
  const token = issueToken({ subject: 'user-3', roles: ['member'], permissions: ['profile:read'], secret });
  const guard = createAuthGuard({ secret });
  const scheme = 'Bearer';
  const authorization = `${scheme} ${token}`;
  const principal = guard({ headers: { authorization } }, { roles: ['member'], permissions: ['profile:read'] });

  assert.equal(principal.id, 'user-3');

  const handler = protect((_request, context) => context.principal.id, guard, { permissions: ['profile:read'] });
  assert.equal(await handler({ headers: { authorization } }), 'user-3');
  assert.throws(() => guard({ headers: { authorization } }, { permissions: ['admin:write'] }), /required access/);
});

test('supports wildcard permission checks and string requirements in RBAC', () => {
  const token = issueToken({
    subject: 'user-wildcard',
    roles: ['member'],
    permissions: ['profile:*', 'notifications:send'],
    secret
  });
  const guard = createAuthGuard({ secret });
  const authorization = 'Bearer ' + token;

  const principal = guard({ headers: { authorization } }, { roles: 'member', permissions: 'profile:read' });
  assert.equal(principal.id, 'user-wildcard');
  assert.throws(
    () => guard({ headers: { authorization } }, { permissions: ['profile:read', 'admin:write'], requireAllPermissions: true }),
    /required access/
  );
});

test('treats empty bearer token headers as missing', () => {
  assert.equal(getBearerToken({ headers: { authorization: 'Bearer ' } }), undefined);
});

test('looks up in-memory accounts by normalized email', async () => {
  const store = new InMemoryAccountStore();
  await store.upsert({ id: 'account-1', email: 'User@Example.COM' });

  assert.equal((await store.findByEmail('user@example.com')).id, 'account-1');
});

test('ignores non-string emails when indexing accounts', async () => {
  const store = new InMemoryAccountStore();
  await store.upsert({ id: 'account-1', email: {} });
  await store.upsert({ id: 'account-1', email: 'user@example.com' });

  assert.equal((await store.findByEmail('USER@EXAMPLE.COM')).id, 'account-1');
  assert.equal(await store.findByEmail({}), undefined);
});

test('exposes an account store contract that requires implementations', async () => {
  const store = new AccountStore();
  assert.ok(new InMemoryAccountStore() instanceof AccountStore);
  await assert.rejects(() => store.findById('user-1'), { code: 'AUTH_STORE_NOT_IMPLEMENTED' });
});
