import type {
  Equation,
  Failure,
  Limits,
  Step,
  Substitution,
  Term,
  UnifyResult,
} from "./types.js";

interface PendingPair {
  lhs: Term;
  rhs: Term;
  srcIndex: number;
  srcId?: string;
}

const v = (name: string): Term => ({ type: "var", name });

/** 结构相等（变量按名身份比较，符号按名 + 参数个数 + 参数比较）。 */
export function termsEqual(a: Term, b: Term): boolean {
  if (a.type === "var" || b.type === "var") {
    return a.type === "var" && b.type === "var" && a.name === b.name;
  }
  if (a.name !== b.name || a.args.length !== b.args.length) return false;
  return a.args.every((arg, i) => termsEqual(arg, b.args[i]!));
}

export function cloneTerm(t: Term): Term {
  return t.type === "var" ? { ...t } : { type: "sym", name: t.name, args: t.args.map(cloneTerm) };
}

export function collectVars(t: Term, out = new Set<string>()): Set<string> {
  if (t.type === "var") out.add(t.name);
  else t.args.forEach((a) => collectVars(a, out));
  return out;
}

export function nodeCount(t: Term): number {
  return t.type === "var" ? 1 : 1 + t.args.reduce((n, a) => n + nodeCount(a), 0);
}

export class BudgetExceeded extends Error {}

/**
 * Robinson 合一。
 * 约定（确定性）：
 *  - 待处理方程先进先出；分解产生的子对按参数顺序追加到队尾。
 *  - 两个不同变量 X、Y 需要绑定时，以字典序较小者为代表（较大者绑定到较小者）。
 *  - 绑定前在当前已生效替换下做 occurs-check（因此 X=Y、Y=f(X) 的间接循环也会被拒绝）。
 */
export function unify(equations: Equation[], limits: Limits, allVarNames: string[]): UnifyResult {
  const subst = new Map<string, Term>();
  const steps: Step[] = [];
  let seq = 0;
  let expanded = 0;

  const addStep = (s: Omit<Step, "seq">) => {
    steps.push({ seq: ++seq, ...s });
  };

  /** 在当前替换下把项完全展开（解引用别名链与嵌套绑定）。 */
  const walk = (t: Term, depth = 0): Term => {
    if (depth > limits.maxDepth) throw new BudgetExceeded("解引用链过长");
    if (t.type === "var") {
      const bound = subst.get(t.name);
      if (bound) return walk(bound, depth + 1);
      return t;
    }
    expanded++;
    if (expanded > limits.maxExpandedNodes) throw new BudgetExceeded("展开节点数超过预算");
    return { type: "sym", name: t.name, args: t.args.map((a) => walk(a, depth + 1)) };
  };

  /** occurs-check：变量名 name 是否出现在已展开项 t 中。 */
  const occurs = (name: string, t: Term): boolean => {
    if (t.type === "var") return t.name === name;
    return t.args.some((a) => occurs(name, walk(a)));
  };

  const queue: PendingPair[] = equations.map((eq, i) => ({
    lhs: eq.lhs,
    rhs: eq.rhs,
    srcIndex: i,
    srcId: eq.id,
  }));

  interface FailInfo extends Failure {
    lhs: Term;
    rhs: Term;
  }
  const fail = (f: FailInfo): UnifyResult => {
    const { code, equationIndex, equationId, message } = f;
    addStep({
      kind: "fail",
      equationIndex,
      equationId,
      lhs: f.lhs,
      rhs: f.rhs,
      detail: message,
    });
    return { status: "failure", failure: { code, equationIndex, equationId, message }, steps };
  };

  try {
    while (queue.length > 0) {
      const pair = queue.shift()!;
      const a = walk(pair.lhs);
      const b = walk(pair.rhs);

      // 变量-变量
      if (a.type === "var" && b.type === "var") {
        if (a.name === b.name) {
          addStep({
            kind: "skip",
            equationIndex: pair.srcIndex,
            equationId: pair.srcId,
            lhs: a,
            rhs: b,
            detail: `${a.name} 与自身相等，跳过`,
          });
          continue;
        }
        const [small, large] = a.name < b.name ? [a.name, b.name] : [b.name, a.name];
        if (occurs(large, v(small))) {
          return fail({
            code: "OCCURS_CHECK",
            equationIndex: pair.srcIndex,
            equationId: pair.srcId,
            lhs: a,
            rhs: b,
            message: `occurs-check 失败：变量 ${large} 出现在 ${small} 的绑定结构中，绑定将构成循环（拒绝无限项）`,
          });
        }
        subst.set(large, v(small));
        addStep({
          kind: "alias",
          equationIndex: pair.srcIndex,
          equationId: pair.srcId,
          lhs: a,
          rhs: b,
          variable: large,
          boundTo: v(small),
          detail: `变量别名：${large} := ${small}（字典序较小者为代表）`,
        });
        continue;
      }

      // 恰有一个是变量
      if (a.type === "var" || b.type === "var") {
        const variableSide = a.type === "var" ? a : b;
        const other = a.type === "var" ? b : a;
        if (occurs(variableSide.name, other)) {
          return fail({
            code: "OCCURS_CHECK",
            equationIndex: pair.srcIndex,
            equationId: pair.srcId,
            lhs: a,
            rhs: b,
            message: `occurs-check 失败：变量 ${variableSide.name} 出现在项 ${formatTerm(other)} 中，绑定将导致无限项`,
          });
        }
        subst.set(variableSide.name, cloneTerm(other));
        addStep({
          kind: "bind",
          equationIndex: pair.srcIndex,
          equationId: pair.srcId,
          lhs: a,
          rhs: b,
          variable: variableSide.name,
          boundTo: cloneTerm(other),
          detail: `绑定：${variableSide.name} := ${formatTerm(other)}`,
        });
        continue;
      }

      // 两个符号项
      if (a.name !== b.name) {
        return fail({
          code: "CONSTANT_MISMATCH",
          equationIndex: pair.srcIndex,
          equationId: pair.srcId,
          lhs: a,
          rhs: b,
          message:
            a.args.length === 0 && b.args.length === 0
              ? `常量冲突：${a.name} ≠ ${b.name}`
              : `函数名冲突：${a.name}/${a.args.length} ≠ ${b.name}/${b.args.length}`,
        });
      }
      if (a.args.length !== b.args.length) {
        return fail({
          code: "SYMBOL_ARITY_MISMATCH",
          equationIndex: pair.srcIndex,
          equationId: pair.srcId,
          lhs: a,
          rhs: b,
          message: `符号 ${a.name} 参数个数不一致：${a.args.length} ≠ ${b.args.length}`,
        });
      }
      if (a.args.length === 0) {
        addStep({
          kind: "skip",
          equationIndex: pair.srcIndex,
          equationId: pair.srcId,
          lhs: a,
          rhs: b,
          detail: `相同常量 ${a.name}，跳过`,
        });
        continue;
      }
      addStep({
        kind: "decompose",
        equationIndex: pair.srcIndex,
        equationId: pair.srcId,
        lhs: a,
        rhs: b,
        detail: `分解 ${a.name}/${a.args.length}：追加 ${a.args.length} 个参数对`,
      });
      for (let k = 0; k < a.args.length; k++) {
        queue.push({
          lhs: a.args[k]!,
          rhs: b.args[k]!,
          srcIndex: pair.srcIndex,
          srcId: pair.srcId,
        });
      }
    }
  } catch (err) {
    if (err instanceof BudgetExceeded) {
      addStep({
        kind: "fail",
        equationIndex: -1,
        lhs: { type: "sym", name: "∅", args: [] },
        rhs: { type: "sym", name: "∅", args: [] },
        detail: err.message,
      });
      return {
        status: "failure",
        failure: { code: "RESOURCE_LIMIT", equationIndex: -1, message: err.message },
        steps,
      };
    }
    throw err;
  }

  // 组合最终替换：对每个出现过的变量做完全展开，仅保留被绑定者。
  const substitution: Substitution = {};
  for (const name of allVarNames) {
    const resolved = walk(v(name));
    if (!(resolved.type === "var" && resolved.name === name)) {
      substitution[name] = resolved;
    }
  }

  // 应用最终替换并独立核验每对原方程两侧相等。
  const results = equations.map((eq, i) => {
    const lhs = applySubstitution(substitution, eq.lhs, limits);
    const rhs = applySubstitution(substitution, eq.rhs, limits);
    if (!termsEqual(lhs, rhs)) {
      // 理论上不可达：作为内部不变量保护。
      throw new Error(`内部错误：方程 ${i} 应用替换后仍不相等`);
    }
    return { equationIndex: i, equationId: eq.id, lhs, rhs };
  });

  return { status: "success", substitution, results, steps };
}

/** 将替换应用到任意项（独立函数，可对“其他项”复用已保存替换）。幂等。 */
export function applySubstitution(substitution: Substitution, t: Term, limits?: Limits): Term {
  let budget = limits?.maxExpandedNodes ?? Number.POSITIVE_INFINITY;
  const go = (term: Term, depth: number): Term => {
    if (limits && depth > limits.maxDepth) throw new BudgetExceeded("应用替换时深度超限");
    if (term.type === "var") {
      const target = substitution[term.name];
      if (target) {
        budget--;
        if (budget < 0) throw new BudgetExceeded("应用替换时结果大小超过预算");
        return go(target, depth + 1);
      }
      return term;
    }
    budget--;
    if (budget < 0) throw new BudgetExceeded("应用替换时结果大小超过预算");
    return { type: "sym", name: term.name, args: term.args.map((a) => go(a, depth + 1)) };
  };
  return go(t, 0);
}

/** 校验替换幂等：应用两次与一次结果相同。 */
export function assertIdempotent(substitution: Substitution, limits: Limits): boolean {
  for (const [name, term] of Object.entries(substitution)) {
    const once = applySubstitution(substitution, term, limits);
    const twice = applySubstitution(substitution, once, limits);
    if (!termsEqual(once, twice)) return false;
    if (!(once.type === "var" && once.name === name) && collectVars(once).has(name)) return false;
  }
  return true;
}

/** 紧凑文本化，仅用于诊断/CLI。 */
export function formatTerm(t: Term): string {
  if (t.type === "var") return t.name;
  if (t.args.length === 0) return t.name;
  return `${t.name}(${t.args.map(formatTerm).join(",")})`;
}
