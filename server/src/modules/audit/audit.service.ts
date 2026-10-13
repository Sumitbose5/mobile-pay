import type { Request } from 'express';
import { db, type DbOrTx } from '../../db/client.js';
import { auditLogs } from '../../db/schema/index.js';
import { logger } from '../../lib/logger.js';

export interface AuditInput {
  action: string;
  userId?: string | null;
  targetUserId?: string | null;
  severity?: 'INFO' | 'WARN' | 'CRITICAL';
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

/** Records a security-relevant event. Never throws: auditing must not break the request. */
export async function audit(req: Request, input: AuditInput, conn: DbOrTx = db): Promise<void> {
  try {
    await conn.insert(auditLogs).values({
      userId: input.userId ?? req.auth?.userId ?? null,
      targetUserId: input.targetUserId ?? null,
      action: input.action,
      severity: input.severity ?? 'INFO',
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      ipAddress: req.ip ?? null,
      userAgent: req.get('user-agent')?.slice(0, 500) ?? null,
      requestId: req.id,
      metadata: input.metadata ?? null,
    });
  } catch (err) {
    logger.error({ err, action: input.action }, 'Failed to write audit log');
  }
}

/** Audit entry for work done by background jobs, where there is no HTTP request. */
export async function auditSystem(input: AuditInput, conn: DbOrTx = db): Promise<void> {
  try {
    await conn.insert(auditLogs).values({
      userId: input.userId ?? null,
      targetUserId: input.targetUserId ?? null,
      action: input.action,
      severity: input.severity ?? 'INFO',
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      metadata: input.metadata ?? null,
    });
  } catch (err) {
    logger.error({ err, action: input.action }, 'Failed to write audit log');
  }
}
