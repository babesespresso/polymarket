import { query } from './index';
import { log } from '../logger';

/**
 * Immutable audit trail. Every consequential action — signal decisions,
 * previews, orders, fills, cancellations, exits, errors, admin controls — is
 * appended here. The table has a trigger that rejects UPDATE/DELETE.
 */
export async function audit(
  actor: string,
  action: string,
  detail?: Record<string, unknown>,
  entity?: string,
  entityId?: string,
): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_log (actor, action, entity, entity_id, detail)
       VALUES ($1, $2, $3, $4, $5)`,
      [actor, action, entity ?? null, entityId ?? null, detail ? JSON.stringify(detail) : null],
    );
  } catch (err) {
    // Audit failures must be visible but must not crash the trading loop.
    log.error('audit write failed', {
      action,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
