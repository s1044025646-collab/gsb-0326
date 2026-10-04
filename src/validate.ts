import type { Equation, Limits, Term, ValidationIssue } from "./types.js";
import { parseStrictJSON } from "./parse.js";

const ALLOWED_TERM_FIELDS = new Set(["type", "name", "args"]);

export interface ValidatedInput {
  equations: Equation[];
  /** 符号约定：函数名 -> 参数个数集合。同一名字出现不同元数即冲突。 */
  signatures: Record<string, number[]>;
  variables: string[];
  issues: ValidationIssue[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 校验一个项节点。返回节点数（用于预算统计）并收集问题。
 * depth 为当前节点深度（根 = 1）。
 */
function validateTerm(
  node: unknown,
  path: string,
  depth: number,
  limits: Limits,
  ctx: { issues: ValidationIssue[]; signatures: Map<string, Set<number>>; nodeCount: number; vars: Set<string> },
): Term | null {
  if (depth > limits.maxDepth) {
    ctx.issues.push({ code: "DEPTH_EXCEEDED", message: `项深度超过上限 ${limits.maxDepth}`, path });
    return null;
  }
  if (!isPlainObject(node)) {
    ctx.issues.push({ code: "NOT_OBJECT", message: "项必须是对象", path });
    return null;
  }
  for (const key of Object.keys(node)) {
    if (!ALLOWED_TERM_FIELDS.has(key)) {
      ctx.issues.push({ code: "UNKNOWN_FIELD", message: `未知字段 "${key}"`, path: `${path}.${key}` });
    }
  }
  if (node.type !== "var" && node.type !== "sym") {
    ctx.issues.push({ code: "BAD_TYPE_FIELD", message: `type 必须是 "var" 或 "sym"，实际为 ${JSON.stringify(node.type)}`, path: `${path}.type` });
    return null;
  }
  if (typeof node.name !== "string" || node.name.length === 0) {
    ctx.issues.push({ code: "BAD_NAME", message: "name 必须是非空字符串", path: `${path}.name` });
    return null;
  }

  if (node.type === "var") {
    if ("args" in node) {
      ctx.issues.push({ code: "CONFLICTING_FIELDS", message: "变量节点不允许携带 args（变量与符号字段含义冲突）", path: `${path}.args` });
      return null;
    }
    ctx.nodeCount++;
    ctx.vars.add(node.name);
    return { type: "var", name: node.name };
  }

  if (!Array.isArray(node.args)) {
    ctx.issues.push({ code: "BAD_ARGS", message: "符号节点的 args 必须是数组（常量用空数组）", path: `${path}.args` });
    return null;
  }
  const args: Term[] = [];
  for (let k = 0; k < node.args.length; k++) {
    const child = validateTerm(node.args[k], `${path}.args[${k}]`, depth + 1, limits, ctx);
    if (child) args.push(child);
  }
  const arity = node.args.length;
  const seen = ctx.signatures.get(node.name);
  if (seen) {
    if (!seen.has(arity)) {
      ctx.issues.push({
        code: "BAD_ARGS",
        message: `符号 "${node.name}" 元数冲突：此前为 ${[...seen].join("/")}，此处为 ${arity}`,
        path,
      });
    }
  } else {
    ctx.signatures.set(node.name, new Set([arity]));
  }
  ctx.nodeCount++;
  return { type: "sym", name: node.name, args };
}

export function validateEquations(input: unknown, limits: Limits): ValidatedInput {
  const ctx = {
    issues: [] as ValidationIssue[],
    signatures: new Map<string, Set<number>>(),
    nodeCount: 0,
    vars: new Set<string>(),
  };
  const equations: Equation[] = [];

  if (!isPlainObject(input)) {
    ctx.issues.push({ code: "NOT_OBJECT", message: "请求体必须是对象", path: "$" });
  } else {
    const eqs = input.equations;
    if (!Array.isArray(eqs)) {
      ctx.issues.push({ code: "MISSING_FIELD", message: "缺少 equations 数组", path: "$.equations" });
    } else {
      if (eqs.length > limits.maxEquations) {
        ctx.issues.push({ code: "EQUATIONS_EXCEEDED", message: `方程数 ${eqs.length} 超过上限 ${limits.maxEquations}`, path: "$.equations" });
      }
      const upper = Math.min(eqs.length, limits.maxEquations);
      for (let i = 0; i < upper; i++) {
        const eqPath = `$.equations[${i}]`;
        const raw = eqs[i];
        if (!isPlainObject(raw)) {
          ctx.issues.push({ code: "BAD_EQUATION", message: "方程必须是对象", path: eqPath });
          continue;
        }
        for (const key of Object.keys(raw)) {
          if (key !== "lhs" && key !== "rhs" && key !== "id") {
            ctx.issues.push({ code: "UNKNOWN_FIELD", message: `方程未知字段 "${key}"`, path: `${eqPath}.${key}` });
          }
        }
        if (!("lhs" in raw)) ctx.issues.push({ code: "MISSING_FIELD", message: "方程缺少 lhs", path: `${eqPath}.lhs` });
        if (!("rhs" in raw)) ctx.issues.push({ code: "MISSING_FIELD", message: "方程缺少 rhs", path: `${eqPath}.rhs` });
        if (raw.id !== undefined && typeof raw.id !== "string") {
          ctx.issues.push({ code: "BAD_EQUATION", message: "id 必须是字符串", path: `${eqPath}.id` });
        }
        const lhs = "lhs" in raw ? validateTerm(raw.lhs, `${eqPath}.lhs`, 1, limits, ctx) : null;
        const rhs = "rhs" in raw ? validateTerm(raw.rhs, `${eqPath}.rhs`, 1, limits, ctx) : null;
        if (lhs && rhs) equations.push({ lhs, rhs, ...(typeof raw.id === "string" ? { id: raw.id } : {}) });
      }
    }
  }

  if (ctx.nodeCount > limits.maxNodes) {
    ctx.issues.push({ code: "NODES_EXCEEDED", message: `总节点数 ${ctx.nodeCount} 超过上限 ${limits.maxNodes}`, path: "$" });
  }
  const signatures: Record<string, number[]> = {};
  for (const [name, arities] of ctx.signatures) signatures[name] = [...arities].sort((a, b) => a - b);
  return {
    equations,
    signatures,
    variables: [...ctx.vars].sort(),
    issues: ctx.issues,
  };
}

/** 解析并校验一段 JSON 文本。 */
export function validateJSONText(text: string, limits: Limits): { parsed?: ValidatedInput; issues: ValidationIssue[] } {
  const { value, issue } = parseStrictJSON(text);
  if (issue) return { issues: [issue] };
  const parsed = validateEquations(value, limits);
  return { parsed, issues: parsed.issues };
}
