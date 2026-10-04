import { Store, newId, type AnalysisRecord } from "./db.js";
import { validateEquations, type ValidatedInput } from "./validate.js";
import { applySubstitution, termsEqual, unify } from "./unify.js";
import { DEFAULT_LIMITS, type Equation, type Limits, type Substitution, type Term } from "./types.js";

export class ServiceError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export interface CreateOptions {
  input: unknown;
  parentId?: string;
  limits?: Partial<Limits>;
  id?: string;
}

export class AnalysisService {
  constructor(private store: Store) {}

  validate(input: unknown, overrides?: Partial<Limits>): { validated: ValidatedInput; limits: Limits } {
    const limits: Limits = { ...DEFAULT_LIMITS, ...(overrides ?? {}) };
    return { validated: validateEquations(input, limits), limits };
  }

  /** 校验并执行合一，然后持久化。校验失败抛错且绝不写库（旧分析不受影响）。 */
  create(options: CreateOptions): AnalysisRecord {
    const { validated, limits } = this.validate(options.input, options.limits);
    if (validated.issues.length > 0) {
      throw new ServiceError("VALIDATION_FAILED", "输入校验失败", validated.issues);
    }
    let result;
    try {
      result = unify(validated.equations, limits, validated.variables);
    } catch (err) {
      throw new ServiceError("RESOURCE_LIMIT", (err as Error).message);
    }
    const id = options.id ?? newId();
    return this.store.save({
      id,
      parentId: options.parentId ?? null,
      status: result.status,
      equations: validated.equations,
      signatures: validated.signatures,
      variables: validated.variables,
      substitution: result.status === "success" ? result.substitution : null,
      failure: result.status === "failure" ? result.failure : null,
      steps: result.steps,
      limits,
    });
  }

  get(id: string): AnalysisRecord {
    const rec = this.store.get(id);
    if (!rec) throw new ServiceError("NOT_FOUND", `分析 ${id} 不存在`);
    return rec;
  }

  list(limit?: number) {
    return this.store.list(limit);
  }

  /** 对其他项应用已保存替换（重启后直接从 SQLite 读取，不依赖进程缓存）。 */
  apply(id: string, term: Term): { term: Term } {
    const rec = this.get(id);
    if (rec.status !== "success" || !rec.substitution) {
      throw new ServiceError("NO_SUBSTITUTION", "失败的分析没有可应用的替换");
    }
    try {
      return { term: applySubstitution(rec.substitution, term, rec.limits) };
    } catch (err) {
      throw new ServiceError("RESOURCE_LIMIT", (err as Error).message);
    }
  }

  steps(id: string, offset = 0, limit = 20) {
    const rec = this.get(id);
    const total = rec.steps.length;
    const start = Math.max(0, Math.min(offset, total));
    const slice = rec.steps.slice(start, start + Math.max(1, limit));
    return { total, offset: start, limit, steps: slice };
  }

  /**
   * 比较两次分析：是否可通过变量一致改名得到相同结果。
   * 采用确定性的一阶项同构判定（变量为重命名对象，符号名固定）。
   */
  compare(idA: string, idB: string): { equivalent: boolean; renaming?: Record<string, string>; reason?: string } {
    const a = this.get(idA);
    const b = this.get(idB);
    if (a.status !== b.status) {
      return { equivalent: false, reason: `状态不同：${a.status} vs ${b.status}` };
    }
    if (a.status === "failure") {
      return {
        equivalent: a.failure?.code === b.failure?.code,
        reason: a.failure?.code === b.failure?.code ? undefined : `失败码不同：${a.failure?.code} vs ${b.failure?.code}`,
      };
    }
    if (a.equations.length !== b.equations.length) {
      return { equivalent: false, reason: "方程数量不同" };
    }
    const mapAB = new Map<string, string>();
    const mapBA = new Map<string, string>();
    try {
      for (let i = 0; i < a.equations.length; i++) {
        isoTerm(a.equations[i]!.lhs, b.equations[i]!.lhs, mapAB, mapBA);
        isoTerm(a.equations[i]!.rhs, b.equations[i]!.rhs, mapAB, mapBA);
      }
    } catch (err) {
      return { equivalent: false, reason: (err as Error).message };
    }
    const renaming: Record<string, string> = {};
    for (const [k, val] of mapAB) renaming[k] = val;
    // 进一步比较应用重命名后的最终结构是否一致
    const subA = a.substitution!;
    const subB = b.substitution!;
    for (const [name, term] of Object.entries(subA)) {
      const mappedName = mapAB.get(name);
      if (mappedName === undefined) {
        // A 中被绑定但 B 中无对应变量，检查其展开结构在 B 中是否也为该结构
        if (!findStructure(term, subB)) return { equivalent: false, reason: `变量 ${name} 的绑定在另一次分析中无对应` };
        continue;
      }
      const other = subB[mappedName];
      if (!other) return { equivalent: false, reason: `${mappedName} 在另一次分析中未绑定` };
      try {
        isoTerm(term, other, new Map(), new Map());
      } catch {
        return { equivalent: false, reason: `绑定结构在重命名后不一致（${name}）` };
      }
    }
    return { equivalent: true, renaming };
  }

  exportReport(id: string): AnalysisRecord {
    return this.get(id);
  }
}

function isoTerm(
  a: Term,
  b: Term,
  mapAB: Map<string, string>,
  mapBA: Map<string, string>,
): void {
  if (a.type === "var" || b.type === "var") {
    if (a.type !== "var" || b.type !== "var") throw new Error("变量与符号位置不一致");
    const known = mapAB.get(a.name);
    const rev = mapBA.get(b.name);
    if (known !== undefined && known !== b.name) throw new Error(`变量 ${a.name} 重命名不一致`);
    if (rev !== undefined && rev !== a.name) throw new Error(`变量 ${b.name} 重命名冲突`);
    mapAB.set(a.name, b.name);
    mapBA.set(b.name, a.name);
    return;
  }
  if (a.name !== b.name || a.args.length !== b.args.length) {
    throw new Error(`符号结构不一致：${a.name}/${a.args.length} vs ${b.name}/${b.args.length}`);
  }
  a.args.forEach((arg, i) => isoTerm(arg, b.args[i]!, mapAB, mapBA));
}

function findStructure(term: Term, sub: Substitution): boolean {
  return Object.values(sub).some((t) => termsEqual(t, term));
}
