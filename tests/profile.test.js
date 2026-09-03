import assert from 'node:assert/strict';
import test from 'node:test';
import { ProfileService, normalizeProfile, validateProfile } from '../src/profile/index.js';

test('normalizes and validates profile input', async () => {
  const service = new ProfileService();
  const profile = await service.create({
    id: 'profile-1',
    displayName: '  Charles  ',
    contact: { email: 'USER@Example.COM ' },
    timezone: 'America/New_York',
    locale: 'en-US',
    avatarUrl: 'https://example.com/avatar.png'
  });

  assert.equal(profile.displayName, 'Charles');
  assert.equal(profile.contact.email, 'user@example.com');
  assert.equal(profile.status, 'active');
  assert.deepEqual(validateProfile(profile), []);
});

test('normalizes empty optional profile contact fields to undefined', () => {
  const profile = normalizeProfile({ id: 'profile-empty-contact', displayName: 'Empty Contact', contact: { email: '   ' } });

  assert.equal(profile.contact.email, undefined);
});

test('supports CRUD profile service behavior', async () => {
  const service = new ProfileService();
  await service.create({ id: 'profile-2', displayName: 'Traveler', contact: { email: 'traveler@example.com' } });

  assert.equal((await service.get('profile-2')).displayName, 'Traveler');
  assert.equal((await service.update('profile-2', { preferences: { units: 'metric' } })).preferences.units, 'metric');
  assert.equal((await service.list()).length, 1);
  assert.equal(await service.delete('profile-2'), true);
  await assert.rejects(() => service.get('profile-2'), /Profile was not found/);
});

test('rejects duplicate profile IDs with a structured error', async () => {
  const service = new ProfileService();
  await service.create({ id: 'profile-3', displayName: 'Duplicate', contact: { email: 'duplicate@example.com' } });

  await assert.rejects(
    () => service.create({ id: 'profile-3', displayName: 'Duplicate', contact: { email: 'duplicate@example.com' } }),
    (error) => error.code === 'PROFILE_ALREADY_EXISTS' && error.status === 409
  );
});

test('rejects invalid profile data with structured details', async () => {
  const service = new ProfileService();
  await assert.rejects(
    () => service.create({ displayName: 'A', contact: { email: 'bad-email' }, avatarUrl: 'ftp://example.com/avatar.png' }),
    (error) => {
      assert.equal(error.code, 'PROFILE_VALIDATION_FAILED');
      assert.deepEqual(error.details.map((detail) => detail.field).sort(), ['avatarUrl', 'contact.email', 'displayName']);
      return true;
    }
  );
});

test('validates profile id presence', () => {
  const errors = validateProfile(normalizeProfile({ displayName: 'Missing Id' }));

  assert.equal(errors.find((error) => error.field === 'id')?.message, 'Profile id is required');
});

test('rejects non-string profile IDs', () => {
  for (const id of [1, {}]) {
    const errors = validateProfile(normalizeProfile({ id, displayName: 'Invalid ID' }));

    assert.equal(errors.find((error) => error.field === 'id')?.message, 'Profile id is required');
  }
});

test('validates malformed email input without complex regular expressions', () => {
  const profile = normalizeProfile({
    id: 'profile-bad-email',
    displayName: 'Bad Email',
    contact: { email: `${'!.'.repeat(500)}@example.com` }
  });

  assert.equal(validateProfile(profile).find((error) => error.field === 'contact.email')?.message, 'Email address is invalid');
});
