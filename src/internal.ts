// Внутрішній HTTP-застосунок: окремий порт, на який шлюз не веде (розділ 07, platform README).
// Захищений лише ізоляцією мережі compose — прийнятий ризик MVP; сервісні токени — після MVP.
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Db } from './db/index.js';
import { getSnapshot } from './domain/snapshot.js';
import { installErrorHandlers, LOG_REDACT } from './app.js';
import { problem, sendProblem } from './problem.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildInternalApp(deps: { db: Db; logger?: FastifyServerOptions['logger'] }): FastifyInstance {
  const app = Fastify({
    logger: deps.logger ?? { level: process.env.LOG_LEVEL ?? 'info', redact: LOG_REDACT },
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
  });
  installErrorHandlers(app);

  /** Повний знімок даних закладу з snapshot_version (розділ 09). Для timetable-service. */
  app.get<{ Params: { schoolId: string } }>('/internal/v1/schools/:schoolId/snapshot', async (request, reply) => {
    const { schoolId } = request.params;
    if (!UUID_RE.test(schoolId)) return sendProblem(reply, problem(404, 'not_found', 'Не знайдено'));
    return reply.header('cache-control', 'no-store').send(await getSnapshot(deps.db, schoolId.toLowerCase()));
  });

  return app;
}
