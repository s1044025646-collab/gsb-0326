import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { ApiError, Subst, Term } from "./terms";
import { Step, UnifyStatus } from "./unify";

export interface AnalysisRow {
  id: number;
  created_at: string;
  algorithm_version: string;
  status: UnifyStatus;
  equations: Array<{ left: Term; right: Term }>;
  symbols: Record<string, number>;
  substitution: Subst | null;
  steps: Step[];
  error: { code: string; message: string } | null;
}

export class Store {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "unify.db"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS analyses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        algorithm_version TEXT NOT NULL,
        status TEXT NOT NULL,
        equations_json TEXT NOT NULL,
        symbols_json TEXT NOT NULL,
        subst_json TEXT,
        steps_json TEXT NOT NULL,
        error_json TEXT
      );
    `);
  }

  create(a: Omit<AnalysisRow, "id" | "created_at">): number {
    const stmt = this.db.prepare(`
      INSERT INTO analyses (created_at, algorithm_version, status, equations_json, symbols_json, subst_json, steps_json, error_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const r = stmt.run(
      new Date().toISOString(),
      a.algorithm_version,
      a.status,
      JSON.stringify(a.equations),
      JSON.stringify(a.symbols),
      a.substitution === null ? null : JSON.stringify(a.substitution),
      JSON.stringify(a.steps),
      a.error === null ? null : JSON.stringify(a.error),
    );
    return Number(r.lastInsertRowid);
  }

  get(id: number): AnalysisRow {
    const stmt = this.db.prepare("SELECT * FROM analyses WHERE id = ?");
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    if (!row) throw new ApiError("NOT_FOUND", `分析 ${id} 不存在`);
    return {
      id: row.id as number,
      created_at: row.created_at as string,
      algorithm_version: row.algorithm_version as string,
      status: row.status as UnifyStatus,
      equations: JSON.parse(row.equations_json as string),
      symbols: JSON.parse(row.symbols_json as string),
      substitution: row.subst_json === null ? null : JSON.parse(row.subst_json as string),
      steps: JSON.parse(row.steps_json as string),
      error: row.error_json === null ? null : JSON.parse(row.error_json as string),
    };
  }

  list(): Array<{ id: number; created_at: string; status: string; algorithm_version: string }> {
    const stmt = this.db.prepare("SELECT id, created_at, status, algorithm_version FROM analyses ORDER BY id");
    return stmt.all() as Array<{ id: number; created_at: string; status: string; algorithm_version: string }>;
  }

  close(): void {
    this.db.close();
  }
}
