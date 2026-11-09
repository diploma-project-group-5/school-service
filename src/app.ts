// Публічний HTTP-застосунок school-service: /api/v1/school/* лише для укладача (розділ 09).
// Залежності передаються ззовні, тож тести підставляють справжній PostgreSQL і власні ключі JWT.
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import { sql } from 'kysely';
import { actorOf, requireScheduler, type TokenVerifier } from './auth.js';
import type { Db } from './db/index.js';
import { listAudit } from './domain/audit.js';
import type { Ctx } from './domain/changes.js';
import {
  archiveClass,
  archiveSubject,
  createClass,
  createSubject,
  listClasses,
  listSubjects,
  updateClass,
  updateSubject,
} from './domain/classes.js';
import { getCurriculum, replaceCurriculum } from './domain/curriculum.js';
import { getBells, getProfile, replaceBells, updateProfile } from './domain/profile.js';
import { createTeacher, deleteTeacher, exportTeacher, listTeachers, updateTeacher } from './domain/teachers.js';
import { EDUCATION_AREAS } from './db/migrations.js';
import { problem, ProblemError, sendProblem } from './problem.js';

export interface AppDeps {
  db: Db;
  verifyToken: TokenVerifier;
  logger?: FastifyServerOptions['logger'];
}

/** Шлюз не зрізає префікс: маршрути оголошено разом з /api/v1/school. */
export const API_PREFIX = '/api/v1/school';

export const LOG_REDACT = ['req.headers.authorization', 'req.headers["x-access-token"]'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = '^\\d{4}-\\d{2}-\\d{2}$';

const Day = Type.Integer({ minimum: 1, maximum: 6 });
const NullableInt = (max?: number) => Type.Union([Type.Integer({ minimum: 0, ...(max ? { maximum: max } : {}) }), Type.Null()]);

const ProfilePatch = Type.Object(
  {
    lessons_per_day: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 10 }), Type.Null()])),
    saturday: Type.Optional(Type.Boolean()),
    shelter_capacity: Type.Optional(NullableInt(100_000)),
    non_teaching_staff: Type.Optional(NullableInt(10_000)),
    shelter_seats: Type.Optional(NullableInt(100_000)),
    // web може надіслати профіль цілком: назва й версія лише для читання, ігноруються.
    name: Type.Optional(Type.String()),
    snapshot_version: Type.Optional(Type.Integer()),
  },
  { additionalProperties: false },
);

const Bell = Type.Object(
  {
    lesson_no: Type.Integer({ minimum: 1, maximum: 10 }),
    start: Type.String({ pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' }),
    end: Type.String({ pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' }),
  },
  { additionalProperties: false },
);

const ClassInput = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 50 }),
    students: Type.Integer({ minimum: 0, maximum: 60 }),
    in_person_priority: Type.Boolean(),
  },
  { additionalProperties: false },
);

const SubjectInput = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 100 }),
    short_name: Type.String({ minLength: 1, maxLength: 20 }),
    education_area: Type.Union(EDUCATION_AREAS.map((a) => Type.Literal(a))),
    not_in_shelter: Type.Boolean(),
  },
  { additionalProperties: false },
);

const TeacherInput = Type.Object(
  {
    label: Type.String({ minLength: 1, maxLength: 100 }),
    weekly_hours_limit: Type.Integer({ minimum: 0, maximum: 60 }),
    unavailable_days: Type.Array(Day, { maxItems: 6 }),
  },
  { additionalProperties: false },
);

const CurriculumRow = Type.Object(
  {
    class_id: Type.String({ pattern: UUID_RE.source }),
    subject_id: Type.String({ pattern: UUID_RE.source }),
    teacher_id: Type.String({ pattern: UUID_RE.source }),
    hours_per_week: Type.Integer({ minimum: 1, maximum: 60 }),
  },
  { additionalProperties: false },
);

const IdParams = Type.Object({ id: Type.String() });

const AuditQuery = Type.Object(
  {
    from: Type.String({ pattern: DATE_RE }),
    to: Type.String({ pattern: DATE_RE }),
    target: Type.Optional(Type.String({ pattern: UUID_RE.source })),
  },
  { additionalProperties: false },
);

function ctxOf(request: FastifyRequest): Ctx {
  const a = actorOf(request);
  return { schoolId: a.schoolId, actor: a.actor, correlationId: request.id };
}

/** Чужий або неіснуючий ресурс — однаково 404 (розділ 07); не-uuid теж 404, а не 400. */
function idOf(request: FastifyRequest<{ Params: { id: string } }>): string {
  const { id } = request.params;
  if (!UUID_RE.test(id)) throw new ProblemError(problem(404, 'not_found', 'Не знайдено'));
  return id.toLowerCase();
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: deps.logger ?? { level: process.env.LOG_LEVEL ?? 'info', redact: LOG_REDACT },
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  }).withTypeProvider<TypeBoxTypeProvider>();

  installErrorHandlers(app);

  // Для healthcheck контейнера. Через шлюз недоступний: шлюз веде лише /api/v1/school/*.
  app.get('/health', async (_request, reply) => {
    try {
      await sql`select 1`.execute(deps.db);
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'db_unavailable' });
    }
  });

  // Внутрішні маршрути слухають на окремому порту; тут — завжди 404, навіть якщо шлях дійшов.
  app.all(`${API_PREFIX}/internal/*`, async (_request, reply) => sendProblem(reply, problem(404, 'not_found', 'Не знайдено')));

  app.register(
    async (r) => {
      r.addHook('preHandler', requireScheduler(deps.verifyToken));
      const typed = r.withTypeProvider<TypeBoxTypeProvider>();
      const { db } = deps;

      typed.get('/school', async (req) => getProfile(db, actorOf(req).schoolId));
      typed.put('/school', { schema: { body: ProfilePatch } }, async (req) => {
        const { lessons_per_day, saturday, shelter_capacity, non_teaching_staff, shelter_seats } = req.body;
        return updateProfile(db, ctxOf(req), { lessons_per_day, saturday, shelter_capacity, non_teaching_staff, shelter_seats });
      });

      typed.get('/bells', async (req) => getBells(db, actorOf(req).schoolId));
      typed.put('/bells', { schema: { body: Type.Array(Bell, { maxItems: 10 }) } }, async (req) => replaceBells(db, ctxOf(req), req.body));

      typed.get('/classes', async (req) => listClasses(db, actorOf(req).schoolId));
      typed.post('/classes', { schema: { body: ClassInput } }, async (req, reply) => reply.code(201).send(await createClass(db, ctxOf(req), req.body)));
      typed.put('/classes/:id', { schema: { params: IdParams, body: ClassInput } }, async (req) => updateClass(db, ctxOf(req), idOf(req), req.body));
      typed.delete('/classes/:id', { schema: { params: IdParams } }, async (req, reply) => {
        await archiveClass(db, ctxOf(req), idOf(req));
        return reply.code(204).send();
      });

      typed.get('/subjects', async (req) => listSubjects(db, actorOf(req).schoolId));
      typed.post('/subjects', { schema: { body: SubjectInput } }, async (req, reply) =>
        reply.code(201).send(await createSubject(db, ctxOf(req), req.body)),
      );
      typed.put('/subjects/:id', { schema: { params: IdParams, body: SubjectInput } }, async (req) => updateSubject(db, ctxOf(req), idOf(req), req.body));
      typed.delete('/subjects/:id', { schema: { params: IdParams } }, async (req, reply) => {
        await archiveSubject(db, ctxOf(req), idOf(req));
        return reply.code(204).send();
      });

      typed.get('/teachers', async (req) => listTeachers(db, actorOf(req).schoolId));
      typed.post('/teachers', { schema: { body: TeacherInput } }, async (req, reply) =>
        reply.code(201).send(await createTeacher(db, ctxOf(req), req.body as Parameters<typeof createTeacher>[2])),
      );
      typed.put('/teachers/:id', { schema: { params: IdParams, body: TeacherInput } }, async (req) =>
        updateTeacher(db, ctxOf(req), idOf(req), req.body as Parameters<typeof updateTeacher>[3]),
      );
      typed.delete('/teachers/:id', { schema: { params: IdParams } }, async (req, reply) => {
        await deleteTeacher(db, ctxOf(req), idOf(req));
        return reply.code(204).send();
      });
      typed.get('/teachers/:id/export', { schema: { params: IdParams } }, async (req, reply) =>
        reply.header('cache-control', 'no-store').send(await exportTeacher(db, ctxOf(req), idOf(req))),
      );

      typed.get('/curriculum', async (req) => getCurriculum(db, actorOf(req).schoolId));
      typed.put('/curriculum', { schema: { body: Type.Array(CurriculumRow, { maxItems: 5000 }) } }, async (req) =>
        replaceCurriculum(
          db,
          ctxOf(req),
          req.body.map((r) => ({ ...r, class_id: r.class_id.toLowerCase(), subject_id: r.subject_id.toLowerCase(), teacher_id: r.teacher_id.toLowerCase() })),
        ),
      );

      typed.get('/audit', { schema: { querystring: AuditQuery } }, async (req, reply) => {
        const { from, to, target } = req.query;
        if (from > to) return sendProblem(reply, problem(400, 'validation_failed', 'Некоректний період', 'from пізніше за to'));
        return listAudit(db, actorOf(req).schoolId, { from, to, ...(target ? { target: target.toLowerCase() } : {}) });
      });
    },
    { prefix: API_PREFIX },
  );

  return app;
}

/** Спільні обробники помилок для публічного й внутрішнього застосунків. */
export function installErrorHandlers(app: FastifyInstance): void {
  app.setErrorHandler((err, request, reply) => {
    if (err instanceof ProblemError) return sendProblem(reply, err.problem);
    const e = err as { validation?: unknown; statusCode?: number; message: string; code?: string };
    if (e.code === '22P02' || e.code === '22007' || e.code === '22008') {
      // Некоректне значення для PostgreSQL (дата, uuid) — помилка вхідних даних.
      return sendProblem(reply, problem(400, 'validation_failed', 'Некоректні дані'));
    }
    if (e.validation || (e.statusCode && e.statusCode >= 400 && e.statusCode < 500)) {
      return sendProblem(reply, problem(400, 'validation_failed', 'Некоректні дані', e.message));
    }
    request.log.error({ err }, 'необроблена помилка');
    return sendProblem(reply, problem(500, 'internal', 'Внутрішня помилка'));
  });
  app.setNotFoundHandler((_request, reply) => sendProblem(reply, problem(404, 'not_found', 'Не знайдено')));
}
