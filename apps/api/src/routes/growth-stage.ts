import type { FastifyInstance } from 'fastify';
import {
  growthStageOverrideSchema,
  growthStageReleaseSchema,
  growthStageRollbackSchema,
  paginationSchema,
} from '@balcony/shared';
import { z } from 'zod';
import { requireAuth } from '../lib/auth.js';
import { parseOrThrow } from '../lib/errors.js';
import { workspaceIdForPlant } from '../services/authorization.js';
import {
  getGrowthStageState,
  listGrowthStageHistory,
  overrideGrowthStage,
  recomputeGrowthEvidence,
  releaseGrowthStage,
  rollbackGrowthStage,
} from '../services/growth-stage.js';

export async function growthStageRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  // 当前生效阶段 + 证据 + 原因链。默认只在内存中重算证据（不落库、不产生 AUTO）。
  app.get('/plants/:id/growth-stage', async (request) => {
    const params = parseOrThrow(z.object({ id: z.string().cuid() }), request.params);
    return getGrowthStageState(params.id, request.auth!.user.id, { persistEvidence: false });
  });

  // 显式重算：覆盖证据行，人工未锁定时按推断结果追加 AUTO 事件。
  app.post('/plants/:id/growth-stage/recompute', async (request) => {
    const params = parseOrThrow(z.object({ id: z.string().cuid() }), request.params);
    await workspaceIdForPlant(params.id, request.auth!.user.id, 'EDITOR');
    const result = await recomputeGrowthEvidence(params.id, { persist: true });
    return getGrowthStageState(params.id, request.auth!.user.id, {
      persistEvidence: false,
      anchorEventId: result.appendedAutoEvent?.id,
    });
  });

  // 人工修正：写入即锁定，证据重算不可覆盖。
  app.post('/plants/:id/growth-stage/override', async (request) => {
    const params = parseOrThrow(z.object({ id: z.string().cuid() }), request.params);
    const input = parseOrThrow(growthStageOverrideSchema, request.body);
    return overrideGrowthStage(params.id, request.auth!.user.id, input);
  });

  // 人工解除锁定：恢复以证据为准（原因链保留）。
  app.post('/plants/:id/growth-stage/release', async (request) => {
    const params = parseOrThrow(z.object({ id: z.string().cuid() }), request.params);
    const input = parseOrThrow(growthStageReleaseSchema, request.body);
    return releaseGrowthStage(params.id, request.auth!.user.id, input);
  });

  // 回退一条 AUTO/MANUAL 事件：追加带原因的 ROLLBACK，重放得出新阶段。
  app.post('/plants/:id/growth-stage/rollback', async (request) => {
    const params = parseOrThrow(z.object({ id: z.string().cuid() }), request.params);
    const input = parseOrThrow(growthStageRollbackSchema, request.body);
    return rollbackGrowthStage(params.id, request.auth!.user.id, input);
  });

  // 事件历史（含已作废事件与所有回退记录）。
  app.get('/plants/:id/growth-stage/history', async (request) => {
    const params = parseOrThrow(z.object({ id: z.string().cuid() }), request.params);
    const query = parseOrThrow(paginationSchema, request.query);
    return listGrowthStageHistory(params.id, request.auth!.user.id, query.limit, query.cursor);
  });
}
