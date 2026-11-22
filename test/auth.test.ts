// Доступ: лише токен клієнта web з роллю scheduler і school_id; помилки — application/problem+json.
import { generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { newSchool, testApp, type TestCtx } from './helpers.js';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await testApp();
});
afterAll(() => ctx.close());

const getClasses = (token?: string) =>
  ctx.app.inject({ method: 'GET', url: '/api/v1/school/classes', headers: token ? { authorization: `Bearer ${token}` } : {} });

describe('доступ до /api/v1/school', () => {
  test('без токена → 401 problem+json', async () => {
    const res = await getClasses();
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ status: 401, code: 'unauthorized', type: 'urn:lad:problem:unauthorized' });
  });

  test('сміття замість токена → 401', async () => {
    expect((await getClasses('not-a-jwt')).statusCode).toBe(401);
  });

  test('заголовок без Bearer → 401', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/school/classes', headers: { authorization: 'Basic abc' } });
    expect(res.statusCode).toBe(401);
  });

  test('прострочений, чужий iss, чужий azp, чужий ключ → 401', async () => {
    const claims = { school_id: newSchool(), realm_access: { roles: ['scheduler'] } };
    const { privateKey } = await generateKeyPair('RS256');
    const tokens = [
      await ctx.tokens.sign(claims, { expiresIn: Math.floor(Date.now() / 1000) - 60 }),
      await ctx.tokens.sign(claims, { issuer: 'http://evil/idp/realms/lad' }),
      await ctx.tokens.sign({ ...claims, azp: 'tenant-service' }),
      await ctx.tokens.sign(claims, { key: privateKey }),
    ];
    for (const t of tokens) expect((await getClasses(t)).statusCode).toBe(401);
  });

  test('без токена з некоректним тілом → 401, а не 400 зі схемою (Z4-7)', async () => {
    const put = await ctx.app.inject({ method: 'PUT', url: '/api/v1/school/school', payload: { bogus: 1 } });
    expect(put.statusCode).toBe(401);
    expect(put.body).not.toContain('bogus');
    expect((await ctx.app.inject({ method: 'POST', url: '/api/v1/school/classes', payload: {} })).statusCode).toBe(401);
  });

  test('X-Request-Id: короткий безпечний — у correlation_id події, довгий чи дивний — замінено uuid (Z3-9)', async () => {
    const put = async (requestId: string) => {
      const school = newSchool();
      const res = await ctx.app.inject({
        method: 'PUT',
        url: '/api/v1/school/school',
        headers: { authorization: `Bearer ${await ctx.tokens.scheduler(school)}`, 'x-request-id': requestId },
        payload: { lessons_per_day: 6 },
      });
      expect(res.statusCode).toBe(200);
      return (await ctx.events(school))[0]!.correlation_id;
    };
    expect(await put('req-5f2c9a')).toBe('req-5f2c9a');
    for (const bad of ['x'.repeat(200), 'a b', 'кирилиця']) expect(await put(bad)).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('sysadmin → 403', async () => {
    const res = await getClasses(await ctx.tokens.sysadmin());
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'forbidden' });
  });

  test('укладач без school_id або з не-uuid → 403', async () => {
    expect((await getClasses(await ctx.tokens.sign({ realm_access: { roles: ['scheduler'] } }))).statusCode).toBe(403);
    expect((await getClasses(await ctx.tokens.sign({ school_id: 'abc', realm_access: { roles: ['scheduler'] } }))).statusCode).toBe(403);
  });

  test('укладач → 200', async () => {
    const res = await getClasses(await ctx.tokens.scheduler(newSchool()));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});

describe('інше', () => {
  test('внутрішні маршрути на публічному порту → 404, навіть з токеном', async () => {
    const school = newSchool();
    const res = await ctx.as(school, 'GET', `/internal/v1/schools/${school}/snapshot`);
    expect(res.statusCode).toBe(404);
    const anon = await ctx.app.inject({ method: 'GET', url: `/api/v1/school/internal/v1/schools/${school}/snapshot` });
    expect(anon.statusCode).toBe(404);
  });

  test('битий JSON → 400 problem+json', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/school/classes',
      headers: { authorization: `Bearer ${await ctx.tokens.scheduler(newSchool())}`, 'content-type': 'application/json' },
      payload: '{"name": ',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'validation_failed' });
  });

  test('невідомий маршрут → 404 problem+json', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/school/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'not_found' });
  });

  test('/health перевіряє базу', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toEqual({ status: 'ok' });
  });

  test('токен не потрапляє в лог', async () => {
    const token = await ctx.tokens.scheduler(newSchool());
    await getClasses(token);
    expect(ctx.logs.lines.join('')).not.toContain(token);
  });
});
