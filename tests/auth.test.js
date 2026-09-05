import assert from 'node:assert/strict';
import test from 'node:test';
import { AccountStore, authorize, createAccessPolicy, revokeSession, toAccessPolicy, decodeToken, describeToken, createAuthGuard, createRoleRegistry, getBearerToken, InMemoryAccountStore, InMemoryTokenRevocationStore, issueToken, issueTokenPair, protect, refreshAccessToken, resolvePrincipal, rotateTokenPair, TokenRevocationStore, verifyToken } from '../src/auth/index.js';

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
  assert.throws(() => guard({ headers: { authorization } }, { roles: {} }), /required access/);
  assert.throws(() => guard({ headers: { authorization } }, { roles: '' }), /required access/);
  assert.throws(() => guard({ headers: { authorization } }, { permissions: {} }), /required access/);
  assert.throws(() => guard({ headers: { authorization } }, { permissions: ['profile:read', ''] }), /required access/);
  assert.throws(() => guard({ headers: { authorization } }, { permissions: 'notifications:*' }), /required access/);
  assert.throws(() => guard({ headers: { authorization } }, { permissions: 'profile:' }), /required access/);
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

test('rejects revoked tokens by jti and by subject cutoff', () => {
  const revocationStore = new InMemoryTokenRevocationStore();
  const token = issueToken({ subject: 'user-revoke', roles: ['member'], secret });
  const payload = verifyToken(token, { secret });
  const guard = createAuthGuard({ secret, revocationStore });
  const authorization = 'Bearer ' + token;

  assert.equal(guard({ headers: { authorization } }).id, 'user-revoke');

  revocationStore.revokeToken(payload);
  assert.throws(() => guard({ headers: { authorization } }), { code: 'AUTH_TOKEN_REVOKED' });

  const otherToken = issueToken({ subject: 'user-logout-all', secret });
  const otherPayload = verifyToken(otherToken, { secret });
  revocationStore.revokeSubject('user-logout-all');
  assert.equal(revocationStore.isRevoked(otherPayload), true);
  assert.equal(revocationStore.isRevoked({ sub: 'someone-else', iat: otherPayload.iat }), false);
});

test('prunes expired revocation entries and validates inputs', () => {
  const revocationStore = new InMemoryTokenRevocationStore();
  const token = issueToken({ subject: 'user-prune', secret, ttlSeconds: 60 });
  const longLivedToken = issueToken({ subject: 'user-keep', secret, ttlSeconds: 3_600 });
  revocationStore.revokeToken(verifyToken(token, { secret }));
  revocationStore.revokeToken(verifyToken(longLivedToken, { secret }));

  assert.equal(revocationStore.prune(new Date(Date.now() + 120_000)), 1);
  assert.equal(revocationStore.prune(new Date(Date.now() + 120_000)), 0);
  assert.equal(revocationStore.isRevoked(verifyToken(longLivedToken, { secret })), true);
  assert.throws(() => revocationStore.revokeToken({}), { code: 'AUTH_TOKEN_NOT_REVOCABLE' });
  assert.throws(() => revocationStore.revokeSubject(''), { code: 'AUTH_MISSING_SUBJECT' });
  assert.throws(() => revocationStore.revokeSubject('user-1', { issuedBefore: 'not-a-date' }), { code: 'AUTH_INVALID_REVOCATION_TIME' });
  assert.throws(() => new TokenRevocationStore().isRevoked({}), { code: 'AUTH_REVOCATION_STORE_NOT_IMPLEMENTED' });
});

test('rotates refresh tokens and invalidates the previous refresh token', () => {
  const revocationStore = new InMemoryTokenRevocationStore();
  const pair = issueTokenPair({ subject: 'user-rotate', roles: ['member'], permissions: ['profile:read'], secret });
  const rotated = rotateTokenPair(pair.refreshToken, { secret, revocationStore });

  assert.equal(verifyToken(rotated.accessToken, { secret, expectedUse: 'access' }).sub, 'user-rotate');
  assert.deepEqual(verifyToken(rotated.refreshToken, { secret, expectedUse: 'refresh' }).permissions, ['profile:read']);
  assert.notEqual(rotated.refreshToken, pair.refreshToken);
  assert.throws(
    () => verifyToken(pair.refreshToken, { secret, expectedUse: 'refresh', revocationStore }),
    { code: 'AUTH_TOKEN_REVOKED' }
  );
  assert.throws(() => rotateTokenPair(rotated.refreshToken, { secret, revocationStore: {} }), { code: 'AUTH_INVALID_REVOCATION_STORE' });
  assert.throws(() => verifyToken(rotated.accessToken, { secret, revocationStore: {} }), { code: 'AUTH_INVALID_REVOCATION_STORE' });
});

test('resolves permissions from a role registry with inheritance', () => {
  const registry = createRoleRegistry({
    member: ['profile:read'],
    moderator: { permissions: ['post:delete'], inherits: ['member'] },
    admin: { permissions: ['*'], inherits: ['moderator', 'admin'] }
  });

  assert.deepEqual(registry.roles(), ['member', 'moderator', 'admin']);
  assert.deepEqual(registry.permissionsFor(['moderator']), ['post:delete', 'profile:read']);
  assert.deepEqual(registry.permissionsFor(['unknown']), []);
  assert.deepEqual(registry.permissionsFor('member'), ['profile:read']);
  assert.deepEqual(registry.permissionsFor({}), []);

  const resolved = resolvePrincipal({ roles: ['moderator'], permissions: ['profile:read'] }, registry);
  assert.deepEqual(resolved.permissions, ['profile:read', 'post:delete']);
  assert.deepEqual(resolvePrincipal({ roles: ['member'] }), { roles: ['member'] });
  assert.throws(() => resolvePrincipal({ roles: [] }, {}), { code: 'AUTH_INVALID_ROLE_REGISTRY' });
  assert.throws(() => createRoleRegistry([]), { code: 'AUTH_INVALID_ROLE_REGISTRY' });
  assert.throws(() => createRoleRegistry({ member: [1] }), { code: 'AUTH_INVALID_ROLE_REGISTRY' });
});

test('guard enforces registry-derived permissions that are absent from the token', () => {
  const registry = createRoleRegistry({ moderator: { permissions: ['post:delete'], inherits: ['member'] }, member: ['profile:read'] });
  const token = issueToken({ subject: 'user-registry', roles: ['moderator'], secret });
  const guard = createAuthGuard({ secret, roleRegistry: registry });
  const authorization = 'Bearer ' + token;

  assert.deepEqual(guard({ headers: { authorization } }, { permissions: ['post:delete', 'profile:read'] }).roles, ['moderator']);
  assert.throws(() => guard({ headers: { authorization } }, { permissions: ['billing:write'] }), { code: 'AUTH_FORBIDDEN' });
});

test('authorize throws a 403 platform error outside of route guards', () => {
  const principal = { id: 'worker', roles: ['job-runner'], permissions: ['notifications:send'] };
  assert.equal(authorize(principal, { permissions: ['notifications:send'] }), principal);
  assert.throws(() => authorize(principal, { roles: ['admin'] }), { code: 'AUTH_FORBIDDEN', status: 403 });
});

test('detects refresh token reuse and revokes every session for the subject', () => {
  const revocationStore = new InMemoryTokenRevocationStore();
  const reuse = [];
  const pair = issueTokenPair({ subject: 'user-replay', roles: ['member'], secret });
  const rotated = rotateTokenPair(pair.refreshToken, { secret, revocationStore });

  assert.throws(
    () => rotateTokenPair(pair.refreshToken, { secret, revocationStore, onReuseDetected: (event) => reuse.push(event) }),
    { code: 'AUTH_REFRESH_TOKEN_REUSED', status: 401 }
  );
  assert.deepEqual(reuse.map((event) => event.subject), ['user-replay']);
  assert.throws(
    () => verifyToken(rotated.accessToken, { secret, expectedUse: 'access', revocationStore }),
    { code: 'AUTH_TOKEN_REVOKED' }
  );
});

test('keeps other sessions alive when reuse detection should not revoke the subject', () => {
  const revocationStore = new InMemoryTokenRevocationStore();
  const pair = issueTokenPair({ subject: 'user-scoped-replay', roles: ['member'], secret });
  const rotated = rotateTokenPair(pair.refreshToken, { secret, revocationStore });

  assert.throws(
    () => rotateTokenPair(pair.refreshToken, { secret, revocationStore, revokeSubjectOnReuse: false }),
    { code: 'AUTH_REFRESH_TOKEN_REUSED' }
  );
  assert.equal(verifyToken(rotated.accessToken, { secret, expectedUse: 'access', revocationStore }).sub, 'user-scoped-replay');
});

test('expands inherited roles onto the principal without rewriting token roles', () => {
  const registry = createRoleRegistry({
    member: ['profile:read'],
    moderator: { permissions: ['post:delete'], inherits: ['member'] },
    admin: { permissions: ['*'], inherits: ['moderator'] }
  });

  assert.deepEqual(registry.rolesFor(['admin']), ['admin', 'moderator', 'member']);
  assert.deepEqual(registry.rolesFor(['unknown']), ['unknown']);
  assert.deepEqual(registry.rolesFor({}), []);

  const principal = resolvePrincipal({ id: 'user-1', roles: ['admin'] }, registry);
  assert.deepEqual(principal.roles, ['admin']);
  assert.deepEqual(principal.effectiveRoles, ['admin', 'moderator', 'member']);
  assert.equal(authorize(principal, { roles: ['member'] }), principal);
  assert.deepEqual(resolvePrincipal({ roles: ['admin'] }, { permissionsFor: () => [] }).effectiveRoles, ['admin']);
});

test('decodes and describes tokens for introspection', () => {
  const issuedAt = new Date('2026-01-01T00:00:00Z');
  const token = issueToken({ subject: 'user-describe', roles: ['member'], secret, issuer: 'platform-shared', audience: 'social', ttlSeconds: 60, now: issuedAt });
  const { header, payload } = decodeToken(token);

  assert.equal(header.alg, 'HS256');
  assert.equal(payload.sub, 'user-describe');

  const summary = describeToken(payload, { now: new Date('2026-01-01T00:00:30Z') });
  assert.equal(summary.tokenUse, 'access');
  assert.equal(summary.issuedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(summary.expiresAt, '2026-01-01T00:01:00.000Z');
  assert.equal(summary.expiresInSeconds, 30);
  assert.equal(summary.expired, false);
  assert.equal(describeToken(payload, { now: '2026-01-01T00:00:30Z' }).expiresInSeconds, 30);
  assert.equal(describeToken(payload, { now: new Date('2026-01-01T00:05:00Z') }).expired, true);
  assert.throws(() => describeToken(payload, { now: 'invalid-date' }), { code: 'AUTH_INVALID_TOKEN' });
  assert.throws(() => decodeToken('not-a-token'), { code: 'AUTH_INVALID_TOKEN' });
  assert.throws(() => decodeToken(42), { code: 'AUTH_INVALID_TOKEN' });
  assert.throws(() => describeToken(null), { code: 'AUTH_INVALID_TOKEN' });
});

test('issues access and refresh tokens under one session id and revokes them together', () => {
  const revocationStore = new InMemoryTokenRevocationStore();
  const pair = issueTokenPair({ subject: 'user-session', roles: ['member'], secret });
  const accessPayload = verifyToken(pair.accessToken, { secret, expectedUse: 'access' });
  const refreshPayload = verifyToken(pair.refreshToken, { secret, expectedUse: 'refresh' });

  assert.equal(accessPayload.sid, pair.sessionId);
  assert.equal(refreshPayload.sid, pair.sessionId);
  assert.notEqual(accessPayload.jti, refreshPayload.jti);
  assert.equal(describeToken(accessPayload).sessionId, pair.sessionId);

  assert.deepEqual(revokeSession(accessPayload, { revocationStore }), { sessionId: pair.sessionId });
  assert.throws(() => verifyToken(pair.accessToken, { secret, expectedUse: 'access', revocationStore }), { code: 'AUTH_TOKEN_REVOKED' });
  assert.throws(() => verifyToken(pair.refreshToken, { secret, expectedUse: 'refresh', revocationStore }), { code: 'AUTH_TOKEN_REVOKED' });
});

test('revokeSession falls back to single token revocation and validates input', () => {
  const revocationStore = new InMemoryTokenRevocationStore();
  const token = issueToken({ subject: 'user-legacy', secret });
  const payload = verifyToken(token, { secret });

  const result = revokeSession(payload, { revocationStore });
  assert.equal(result.tokenId, payload.jti);
  assert.throws(() => verifyToken(token, { secret, revocationStore }), { code: 'AUTH_TOKEN_REVOKED' });
  assert.throws(() => revokeSession(payload, {}), { code: 'AUTH_INVALID_REVOCATION_STORE' });
  assert.throws(() => revokeSession(undefined, { revocationStore }), { code: 'AUTH_INVALID_TOKEN' });
  assert.throws(() => revocationStore.revokeSession(''), { code: 'AUTH_SESSION_NOT_REVOCABLE' });
});

test('refresh token replay ends the replayed session and rotation starts a new one', () => {
  const revocationStore = new InMemoryTokenRevocationStore();
  const pair = issueTokenPair({ subject: 'user-chain', roles: ['member'], secret });
  const rotated = rotateTokenPair(pair.refreshToken, { secret, revocationStore });

  assert.notEqual(rotated.sessionId, pair.sessionId);
  assert.throws(
    () => rotateTokenPair(pair.refreshToken, { secret, revocationStore, revokeSubjectOnReuse: false }),
    { code: 'AUTH_REFRESH_TOKEN_REUSED' }
  );
  // The replayed session's access token stops verifying, the new session survives.
  assert.throws(() => verifyToken(pair.accessToken, { secret, expectedUse: 'access', revocationStore }), { code: 'AUTH_TOKEN_REVOKED' });
  assert.equal(verifyToken(rotated.accessToken, { secret, expectedUse: 'access', revocationStore }).sub, 'user-chain');
});

test('refreshed access tokens keep the session id and prune drops expired sessions', () => {
  const revocationStore = new InMemoryTokenRevocationStore();
  const now = new Date('2026-01-01T00:00:00Z');
  const pair = issueTokenPair({ subject: 'user-refresh-session', secret, now });
  const accessToken = refreshAccessToken(pair.refreshToken, { secret, now });
  const payload = verifyToken(accessToken, { secret, expectedUse: 'access', now });

  assert.equal(payload.sid, pair.sessionId);
  revocationStore.revokeSession(payload.sid, { expiresAt: payload.exp });
  assert.equal(revocationStore.prune(now), 0);
  assert.equal(revocationStore.prune(new Date('2026-01-02T00:00:00Z')), 1);
  assert.equal(verifyToken(accessToken, { secret, expectedUse: 'access', now, revocationStore }).sid, pair.sessionId);
});

test('guards expose the session id on the principal', () => {
  const guard = createAuthGuard({ secret });
  const pair = issueTokenPair({ subject: 'user-guard-session', roles: ['member'], secret });
  const principal = guard({ headers: { authorization: 'Bearer ' + pair.accessToken } });
  assert.equal(principal.sessionId, pair.sessionId);
});

test('access policies enforce RBAC outside of HTTP routes', () => {
  const roleRegistry = createRoleRegistry({ coach: ['profile:write'] });
  const policy = createAccessPolicy({
    'profile.update': { permissions: ['profile:write'] },
    'profile.list': { roles: ['admin'] }
  }, { roleRegistry });

  assert.deepEqual(policy.actions(), ['profile.update', 'profile.list']);
  assert.deepEqual(policy.requirementsFor('profile.update'), { permissions: ['profile:write'] });
  assert.equal(policy.enforce('profile.update', { id: 'coach-1', roles: ['coach'] }).id, 'coach-1');
  assert.equal(policy.enforce('profile.read', undefined), undefined);
  assert.throws(() => policy.enforce('profile.list', { id: 'coach-1', roles: ['coach'] }), { code: 'AUTH_FORBIDDEN', status: 403 });
  assert.throws(() => policy.enforce('profile.update', undefined), { code: 'AUTH_PRINCIPAL_REQUIRED', status: 401 });
});

test('access policies validate their configuration and optional principals', () => {
  assert.throws(() => createAccessPolicy([]), { code: 'AUTH_INVALID_POLICY' });
  assert.throws(() => createAccessPolicy({ 'a.b': ['profile:read'] }), { code: 'AUTH_INVALID_POLICY' });

  const optional = createAccessPolicy({ 'job.run': { permissions: ['job:run'] } }, { requirePrincipal: false });
  assert.equal(optional.enforce('job.run', undefined), undefined);
  assert.equal(toAccessPolicy(undefined), undefined);
  assert.equal(toAccessPolicy(optional), optional);
  assert.throws(() => toAccessPolicy({ 'job.run': { roles: ['worker'] } }).enforce('job.run', { id: 'j', roles: [] }), { code: 'AUTH_FORBIDDEN' });
});
