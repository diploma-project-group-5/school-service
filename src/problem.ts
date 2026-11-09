// Помилки у форматі application/problem+json (розділ 07): type, title, status, detail, code.
import type { FastifyReply } from 'fastify';

export type ProblemCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'validation_failed'
  | 'name_taken'
  | 'label_taken'
  | 'unknown_reference'
  | 'in_curriculum'
  | 'archived'
  | 'deleted'
  | 'internal';

export interface Problem {
  type: string;
  title: string;
  status: number;
  code: ProblemCode;
  detail?: string;
}

export function problem(status: number, code: ProblemCode, title: string, detail?: string): Problem {
  return { type: `urn:lad:problem:${code}`, title, status, code, ...(detail ? { detail } : {}) };
}

export function sendProblem(reply: FastifyReply, p: Problem): FastifyReply {
  return reply.code(p.status).type('application/problem+json').send(p);
}

/** Помилка предметної області: обробник помилок застосунку перетворює її на problem+json. */
export class ProblemError extends Error {
  constructor(readonly problem: Problem) {
    super(problem.detail ?? problem.title);
    this.name = 'ProblemError';
  }
}

export const fail = (status: number, code: ProblemCode, title: string, detail?: string): never => {
  throw new ProblemError(problem(status, code, title, detail));
};
