import type { FastifyRequest } from "fastify";
import type { Scope } from "./scope.js";

declare module "fastify" {
  interface FastifyRequest {
    scope?: Scope;
    rawBody?: string;
  }
}

export function scopeOf(req: FastifyRequest): Scope {
  if (!req.scope) throw Object.assign(new Error("로그인이 필요합니다."), { status: 401 });
  return req.scope;
}
