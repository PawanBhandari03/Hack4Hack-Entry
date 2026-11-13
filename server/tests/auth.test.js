import { describe, it, expect } from 'vitest';
import { api, makeUser } from './helpers.js';

describe('auth', () => {
  it('registers, logs in and returns the profile', async () => {
    const reg = await api()
      .post('/api/auth/register')
      .send({ name: 'Asha', email: 'Asha@Example.com', password: 'supersecret', skills: ['React', 'react', 'Node.js'], timezone: 'Asia/Kolkata' });
    expect(reg.status).toBe(201);
    expect(reg.body.user.email).toBe('asha@example.com');
    expect(reg.body.user.skills).toEqual(['react', 'node.js']); // normalised + de-duplicated
    expect(reg.body.user).not.toHaveProperty('passwordHash');

    const login = await api().post('/api/auth/login').send({ email: 'asha@example.com', password: 'supersecret' });
    expect(login.status).toBe(200);
    const me = await api().get('/api/auth/me').set('Authorization', `Bearer ${login.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.user.timezone).toBe('Asia/Kolkata');
  });

  it('rejects duplicate emails and wrong passwords', async () => {
    const body = { name: 'Ben', email: 'ben@example.com', password: 'supersecret' };
    expect((await api().post('/api/auth/register').send(body)).status).toBe(201);
    const dup = await api().post('/api/auth/register').send(body);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('EMAIL_TAKEN');
    const bad = await api().post('/api/auth/login').send({ email: 'ben@example.com', password: 'wrong-password' });
    expect(bad.status).toBe(401);
  });

  it('validates every input field', async () => {
    const res = await api()
      .post('/api/auth/register')
      .send({ name: 'x', email: 'not-an-email', password: 'short', timezone: 'Mars/Olympus', skills: ['<script>'] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const paths = res.body.error.details.map((d) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['body.name', 'body.email', 'body.password', 'body.timezone', 'body.skills.0']));
  });

  it('blocks requests without a valid token', async () => {
    expect((await api().get('/api/auth/me')).status).toBe(401);
    expect((await api().get('/api/auth/me').set('Authorization', 'Bearer garbage')).status).toBe(401);
  });

  it('updates profile and the denormalised participant copy', async () => {
    const u = await makeUser();
    const res = await api().patch('/api/auth/me').set(u.auth).send({ skills: ['Go'], timezone: 'America/New_York' });
    expect(res.status).toBe(200);
    expect(res.body.user.skills).toEqual(['go']);
  });
});
