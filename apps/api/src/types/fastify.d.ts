import type { Session, User } from '@prisma/client';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: {
      session: Session;
      user: User;
    };
  }
}
