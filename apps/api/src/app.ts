import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { authPlugin } from './auth/plugin';
import type { Ctx } from './context';
import { gitHttpRoutes } from './git/http';
import { HttpError } from './lib/errors';
import authRoutes from './routes/auth';
import checkRoutes from './routes/checks';
import codeRoutes from './routes/code';
import orgRoutes from './routes/orgs';
import pullRoutes from './routes/pulls';
import repoRoutes from './routes/repos';
import userRoutes from './routes/user';
import { wsRoutes } from './routes/ws';

declare module 'fastify' {
  interface FastifyInstance {
    ctx: Ctx;
  }
}

export async function buildApp(ctx: Ctx): Promise<FastifyInstance> {
  const dev = ctx.env.NODE_ENV === 'development';
  const app = Fastify({
    logger: {
      level: ctx.env.LOG_LEVEL,
      transport: dev ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } : undefined,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    trustProxy: ctx.env.TRUST_PROXY,
    bodyLimit: 2 * 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>();

  app.decorate('ctx', ctx);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message, details: err.details });
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(400).send({ error: 'validation_failed', message: 'Request validation failed', details: err.validation });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    return reply.code(status).send({
      error: status === 429 ? 'rate_limited' : status >= 500 ? 'internal_error' : 'request_error',
      message: status >= 500 ? 'Something went wrong' : (err as Error).message,
    });
  });

  await app.register(helmet, {
    // JSON API: lock everything down; swagger UI sets its own CSP.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });
  app.addHook('onSend', async (req, reply) => {
    if (!req.url.startsWith('/api/docs') && !reply.hasHeader('content-security-policy')) {
      reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    }
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: '1 minute',
    redis: ctx.rateLimitRedis,
    skipOnError: true,
    nameSpace: 'pcbhub-rl:',
    keyGenerator: (req) => req.user?.id ?? req.ip,
    // Large clones/pushes are throttled by size limits instead.
    allowList: (req) => /\/(info\/refs|git-upload-pack|git-receive-pack)$/.test(req.url.split('?')[0]!),
  });
  await app.register(authPlugin);
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  await app.register(swagger, {
    openapi: { info: { title: 'PCBHub API', version: '0.1.0' }, servers: [{ url: '/' }] },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/api/docs' });

  app.get('/api/health', async () => {
    await ctx.redis.ping();
    await ctx.db.execute('select 1');
    return { ok: true };
  });

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(userRoutes, { prefix: '/api/user' });
  await app.register(orgRoutes, { prefix: '/api/orgs' });
  await app.register(repoRoutes, { prefix: '/api' });
  await app.register(codeRoutes, { prefix: '/api' });
  await app.register(pullRoutes, { prefix: '/api' });
  await app.register(checkRoutes, { prefix: '/api' });
  await app.register(wsRoutes);
  await app.register(gitHttpRoutes);
  return app;
}
