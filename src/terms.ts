export type VarTerm = { type: "var"; name: string };
export type ConstTerm = { type: "const"; name: string };
export type FuncTerm = { type: "func"; name: string; args: Term[] };
export type Term = VarTerm | ConstTerm | FuncTerm;

export type Subst = Record<string, Term>;

export interface Budgets {
  maxDepth: number;
  maxNodes: number;
  maxEquations: number;
  maxSteps: number;
  maxExpansionNodes: number;
}

export const DEFAULT_BUDGETS: Budgets = {
  maxDepth: 64,
  maxNodes: 10000,
  maxEquations: 1000,
  maxSteps: 100000,
  maxExpansionNodes: 100000,
};

export type ErrorCode =
  | "INVALID_TERM"
  | "ARITY_CONFLICT"
  | "BUDGET_EXCEEDED"
  | "UNIFICATION_FAILED"
  | "OCCURS_CHECK_FAILED"
  | "NOT_FOUND"
  | "BAD_REQUEST";

export class ApiError extends Error {
  constructor(public code: ErrorCode, message: string, public details?: unknown) {
    super(message);
  }
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function validateTerm(node: unknown, budgets: Budgets, depth = 1, counter = { n: 0 }): Term {
  if (depth > budgets.maxDepth) {
    throw new ApiError("BUDGET_EXCEEDED", `项深度超过上限 ${budgets.maxDepth}`);
  }
  counter.n++;
  if (counter.n > budgets.maxNodes) {
    throw new ApiError("BUDGET_EXCEEDED", `项总节点数超过上限 ${budgets.maxNodes}`);
  }
  if (!isPlainObject(node)) {
    throw new ApiError("INVALID_TERM", "项节点必须是对象");
  }
  const keys = Object.keys(node).sort();
  const t = node.type;
  if (t === "var") {
    if (keys.join(",") !== "name,type") {
      throw new ApiError("INVALID_TERM", `var 节点只允许 {type,name} 字段，实际: ${keys.join(",")}`);
    }
    if (typeof node.name !== "string" || !NAME_RE.test(node.name)) {
      throw new ApiError("INVALID_TERM", `非法变量名: ${String(node.name)}`);
    }
    return { type: "var", name: node.name };
  }
  if (t === "const") {
    if (keys.join(",") !== "name,type") {
      throw new ApiError("INVALID_TERM", `const 节点只允许 {type,name} 字段，实际: ${keys.join(",")}`);
    }
    if (typeof node.name !== "string" || !NAME_RE.test(node.name)) {
      throw new ApiError("INVALID_TERM", `非法常量名: ${String(node.name)}`);
    }
    return { type: "const", name: node.name };
  }
  if (t === "func") {
    if (keys.join(",") !== "args,name,type") {
      throw new ApiError("INVALID_TERM", `func 节点只允许 {type,name,args} 字段，实际: ${keys.join(",")}`);
    }
    if (typeof node.name !== "string" || !NAME_RE.test(node.name)) {
      throw new ApiError("INVALID_TERM", `非法函数名: ${String(node.name)}`);
    }
    if (!Array.isArray(node.args) || node.args.length === 0) {
      throw new ApiError("INVALID_TERM", "func 节点 args 必须是非空数组（零参数请用 const）");
    }
    const args = node.args.map((a) => validateTerm(a, budgets, depth + 1, counter));
    return { type: "func", name: node.name, args };
  }
  throw new ApiError("INVALID_TERM", `未知节点类型: ${String(t)}`);
}

export function collectSymbols(terms: Term[]): Record<string, number> {
  const table: Record<string, number> = {};
  const check = (name: string, arity: number): void => {
    if (name in table && table[name] !== arity) {
      throw new ApiError("ARITY_CONFLICT", `符号 ${name} 元数冲突: ${table[name]} 与 ${arity}`);
    }
    table[name] = arity;
  };
  const visit = (t: Term): void => {
    if (t.type === "const") {
      check(t.name, 0);
    } else if (t.type === "func") {
      check(t.name, t.args.length);
      t.args.forEach(visit);
    }
  };
  terms.forEach(visit);
  return table;
}

export function termToString(t: Term): string {
  if (t.type === "var") return t.name;
  if (t.type === "const") return t.name;
  return `${t.name}(${t.args.map(termToString).join(",")})`;
}

export function termEqual(a: Term, b: Term): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "var" || a.type === "const") return (a as VarTerm).name === (b as VarTerm).name;
  const fa = a as FuncTerm;
  const fb = b as FuncTerm;
  return fa.name === fb.name && fa.args.length === fb.args.length && fa.args.every((x, i) => termEqual(x, fb.args[i]));
}

export function countNodes(t: Term): number {
  if (t.type !== "func") return 1;
  return 1 + t.args.reduce((s, a) => s + countNodes(a), 0);
}

export function applySubst(t: Term, subst: Subst, budgets: Budgets, counter = { n: 0 }): Term {
  counter.n++;
  if (counter.n > budgets.maxExpansionNodes) {
    throw new ApiError("BUDGET_EXCEEDED", `替换展开结果超过上限 ${budgets.maxExpansionNodes} 节点`);
  }
  if (t.type === "var") {
    const bound = subst[t.name];
    if (bound === undefined) return t;
    return applySubst(bound, subst, budgets, counter);
  }
  if (t.type === "const") return t;
  return { type: "func", name: t.name, args: t.args.map((a) => applySubst(a, subst, budgets, counter)) };
}

export function occursIn(varName: string, t: Term, subst: Subst, budgets: Budgets): boolean {
  const counter = { n: 0 };
  const walk = (node: Term): boolean => {
    counter.n++;
    if (counter.n > budgets.maxExpansionNodes) {
      throw new ApiError("BUDGET_EXCEEDED", "occurs-check 展开超过预算");
    }
    if (node.type === "var") {
      if (node.name === varName) return true;
      const bound = subst[node.name];
      return bound !== undefined && walk(bound);
    }
    if (node.type === "const") return false;
    return node.args.some(walk);
  };
  return walk(t);
}
