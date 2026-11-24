import type { Queryable } from '../db.ts';

export async function audit(
  db: Queryable,
  entry: { organizationId: string; actorId: string | null; action: string; entity: string; entityId?: string; data?: unknown },
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (organization_id, actor_id, action, entity, entity_id, data)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [entry.organizationId, entry.actorId, entry.action, entry.entity, entry.entityId ?? null, entry.data ?? {}],
  );
}
