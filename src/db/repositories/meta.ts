import { newId, nowIso } from "../client";
import type { AuditEventRow, BlockedCompanyRow } from "../schema";

export async function blockCompany(
  db: D1Database,
  input: {
    normalizedCompany: string;
    displayName: string;
    reason?: string | null;
    now?: Date | undefined;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO blocked_companies (normalized_company, display_name, reason, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(input.normalizedCompany, input.displayName, input.reason ?? null, nowIso(input.now))
    .run();
}

export async function listBlockedCompanies(db: D1Database): Promise<BlockedCompanyRow[]> {
  const result = await db.prepare("SELECT * FROM blocked_companies").all<BlockedCompanyRow>();
  return result.results;
}

export async function listBlockedCompanyKeys(db: D1Database): Promise<Set<string>> {
  const rows = await listBlockedCompanies(db);
  return new Set(rows.map((row) => row.normalized_company));
}

export async function insertAuditEvent(
  db: D1Database,
  input: {
    entityType: string;
    entityId: string;
    eventType: string;
    payload?: unknown;
    now?: Date | undefined;
  },
): Promise<AuditEventRow | null> {
  const id = newId();
  await db
    .prepare(
      `INSERT INTO audit_events (id, entity_type, entity_id, event_type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.entityType,
      input.entityId,
      input.eventType,
      input.payload === undefined ? null : JSON.stringify(input.payload),
      nowIso(input.now),
    )
    .run();
  return db.prepare("SELECT * FROM audit_events WHERE id = ?").bind(id).first<AuditEventRow>();
}

export async function listAuditEvents(
  db: D1Database,
  entityType: string,
  entityId: string,
): Promise<AuditEventRow[]> {
  const result = await db
    .prepare(
      "SELECT * FROM audit_events WHERE entity_type = ? AND entity_id = ? ORDER BY created_at ASC",
    )
    .bind(entityType, entityId)
    .all<AuditEventRow>();
  return result.results;
}
