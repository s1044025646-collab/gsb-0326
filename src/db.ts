import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Equation, Limits, Step, Substitution, Failure } from "./types.js";
import { ALGORITHM_VERSION } from "./types.js";

export interface AnalysisRecord {
  id: string;
  createdAt: string;
  parentId: string | null;
  status: "success" | "failure";
  equations: Equation[];
  signatures: Record<string, number[]>;
  variables: string[];
  algorithmVersion: string;
  substitution: Substitution | null;
  failure: Failure | null;
  steps: Step[];
  limits: Limits;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS analyses (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        parent_id TEXT,
        status TEXT NOT NULL,
        equations_json TEXT NOT NULL,
        signatures_json TEXT NOT NULL,
        variables_json TEXT NOT NULL,
        algorithm_version TEXT NOT NULL,
        substitution_json TEXT,
        failure_json TEXT,
        steps_json TEXT NOT NULL,
        limits_json TEXT NOT NULL
      );
    `);
  }

  save(rec: Omit<AnalysisRecord, "createdAt" | "algorithmVersion"> & { parentId?: string | null }): AnalysisRecord {
    const full: AnalysisRecord = {
      ...rec,
      parentId: rec.parentId ?? null,
      createdAt: new Date().toISOString(),
      algorithmVersion: ALGORITHM_VERSION,
    };
    this.db
      .prepare(
        `INSERT INTO analyses
          (id, created_at, parent_id, status, equations_json, signatures_json, variables_json,
           algorithm_version, substitution_json, failure_json, steps_json, limits_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        full.id,
        full.createdAt,
        full.parentId,
        full.status,
        JSON.stringify(full.equations),
        JSON.stringify(full.signatures),
        JSON.stringify(full.variables),
        full.algorithmVersion,
        full.substitution ? JSON.stringify(full.substitution) : null,
        full.failure ? JSON.stringify(full.failure) : null,
        JSON.stringify(full.steps),
        JSON.stringify(full.limits),
      );
    return full;
  }

  get(id: string): AnalysisRecord | null {
    const row = this.db.prepare("SELECT * FROM analyses WHERE id = ?").get(id) as
      | Record<string, string | null>
      | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      createdAt: row.created_at as string,
      parentId: row.parent_id ?? null,
      status: row.status as "success" | "failure",
      equations: JSON.parse(row.equations_json as string),
      signatures: JSON.parse(row.signatures_json as string),
      variables: JSON.parse(row.variables_json as string),
      algorithmVersion: row.algorithm_version as string,
      substitution: row.substitution_json ? JSON.parse(row.substitution_json) : null,
      failure: row.failure_json ? JSON.parse(row.failure_json) : null,
      steps: JSON.parse(row.steps_json as string),
      limits: JSON.parse(row.limits_json as string),
    };
  }

  list(limit = 50): Array<{ id: string; createdAt: string; status: string; parentId: string | null }> {
    const rows = this.db
      .prepare("SELECT id, created_at, status, parent_id FROM analyses ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(limit) as Array<Record<string, string | null>>;
    return rows.map((r) => ({
      id: r.id as string,
      createdAt: r.created_at as string,
      status: r.status as string,
      parentId: r.parent_id ?? null,
    }));
  }

  close(): void {
    this.db.close();
  }
}

export function newId(): string {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `A${stamp}${rand}`;
}
