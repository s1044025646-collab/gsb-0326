import {
  ApiError,
  Budgets,
  DEFAULT_BUDGETS,
  Term,
  applySubst,
  collectSymbols,
  validateTerm,
} from "./terms";
import { Equation, UnifyResult, unify } from "./unify";
import { AnalysisRow, Store } from "./store";

export function parseBudgets(raw: unknown): Budgets {
  const b = { ...DEFAULT_BUDGETS };
  if (raw === undefined || raw === null) return b;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApiError("BAD_REQUEST", "budgets 必须是对象");
  }
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(k in b)) throw new ApiError("BAD_REQUEST", `未知预算字段: ${k}`);
    if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
      throw new ApiError("BAD_REQUEST", `预算 ${k} 必须是正整数`);
    }
    (b as Record<string, number>)[k] = v;
  }
  return b;
}

export function parseEquations(raw: unknown, budgets: Budgets): Equation[] {
  if (!Array.isArray(raw)) throw new ApiError("BAD_REQUEST", "equations 必须是数组");
  if (raw.length > budgets.maxEquations) {
    throw new ApiError("BUDGET_EXCEEDED", `方程数超过上限 ${budgets.maxEquations}`);
  }
  return raw.map((e, i) => {
    if (typeof e !== "object" || e === null || Array.isArray(e)) {
      throw new ApiError("BAD_REQUEST", `方程 ${i} 必须是 {left,right} 对象`);
    }
    const keys = Object.keys(e as object).sort();
    if (keys.join(",") !== "left,right") {
      throw new ApiError("BAD_REQUEST", `方程 ${i} 只允许 {left,right} 字段`);
    }
    const { left, right } = e as { left: unknown; right: unknown };
    return {
      left: validateTerm(left, budgets),
      right: validateTerm(right, budgets),
    };
  });
}

export function runAnalysis(
  store: Store,
  body: { equations?: unknown; budgets?: unknown },
): AnalysisRow {
  const budgets = parseBudgets(body.budgets);
  const equations = parseEquations(body.equations, budgets);
  const symbols = collectSymbols(equations.flatMap((e) => [e.left, e.right]));
  const result: UnifyResult = unify(equations, budgets);
  const id = store.create({
    algorithm_version: result.algorithmVersion,
    status: result.status,
    equations,
    symbols,
    substitution: result.status === "success" ? result.substitution : null,
    steps: result.steps,
    error: result.error,
  });
  return store.get(id);
}

export function applyStoredSubst(
  store: Store,
  id: number,
  termsRaw: unknown,
): { terms: Term[] } {
  const row = store.get(id);
  if (row.status !== "success" || row.substitution === null) {
    throw new ApiError("BAD_REQUEST", `分析 ${id} 没有可用的成功替换（状态: ${row.status}）`);
  }
  if (!Array.isArray(termsRaw)) throw new ApiError("BAD_REQUEST", "terms 必须是数组");
  const budgets = DEFAULT_BUDGETS;
  const terms = termsRaw.map((t) => validateTerm(t, budgets));
  return { terms: terms.map((t) => applySubst(t, row.substitution!, budgets)) };
}
