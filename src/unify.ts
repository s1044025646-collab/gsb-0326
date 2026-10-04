import {
  ApiError,
  Budgets,
  Subst,
  Term,
  applySubst,
  occursIn,
  termEqual,
  termToString,
} from "./terms";

export const ALGORITHM_VERSION = "robinson-1.0.0";

export interface Equation {
  left: Term;
  right: Term;
}

export type StepKind = "decompose" | "skip-identical" | "bind" | "fail";

export interface Step {
  index: number;
  equationIndex: number;
  kind: StepKind;
  left: string;
  right: string;
  detail: string;
}

export type UnifyStatus = "success" | "failure" | "incomplete";

export interface UnifyResult {
  status: UnifyStatus;
  substitution: Subst;
  steps: Step[];
  solvedEquations: Array<{ left: Term; right: Term }> | null;
  error: { code: string; message: string } | null;
  algorithmVersion: string;
}

function deref(t: Term, subst: Subst): Term {
  let cur = t;
  const seen = new Set<string>();
  while (cur.type === "var" && subst[cur.name] !== undefined) {
    if (seen.has(cur.name)) break;
    seen.add(cur.name);
    cur = subst[cur.name];
  }
  return cur;
}

/**
 * Robinson 合一。
 * 确定性规则：
 *  - 方程按输入顺序入队，分解产生的子方程按参数顺序追加到队尾（FIFO）。
 *  - 变量-变量绑定时，名称字典序较大者绑定到较小者（较小名称为代表元）。
 *  - 绑定前在当前替换下做 occurs-check（含间接链）。
 */
export function unify(equations: Equation[], budgets: Budgets): UnifyResult {
  const subst: Subst = {};
  const steps: Step[] = [];
  const queue: Array<{ left: Term; right: Term; equationIndex: number }> = equations.map((e, i) => ({
    left: e.left,
    right: e.right,
    equationIndex: i,
  }));
  let stepIndex = 0;

  const pushStep = (s: Omit<Step, "index">): void => {
    steps.push({ index: stepIndex++, ...s });
    if (steps.length > budgets.maxSteps) {
      throw new ApiError("BUDGET_EXCEEDED", `步骤数超过上限 ${budgets.maxSteps}`);
    }
  };

  try {
    while (queue.length > 0) {
      const { left, right, equationIndex } = queue.shift()!;
      const a = deref(left, subst);
      const b = deref(right, subst);

      if (termEqual(a, b)) {
        pushStep({
          equationIndex,
          kind: "skip-identical",
          left: termToString(a),
          right: termToString(b),
          detail: "两侧在当前替换下相同，跳过",
        });
        continue;
      }

      if (a.type === "var" || b.type === "var") {
        // 统一为 var = other，变量-变量时较大名绑定到较小名
        let varTerm: Term;
        let other: Term;
        if (a.type === "var" && b.type === "var") {
          if (a.name <= b.name) {
            varTerm = b;
            other = a;
          } else {
            varTerm = a;
            other = b;
          }
        } else if (a.type === "var") {
          varTerm = a;
          other = b;
        } else {
          varTerm = b;
          other = a;
        }
        const v = (varTerm as { name: string }).name;
        if (occursIn(v, other, subst, budgets)) {
          pushStep({
            equationIndex,
            kind: "fail",
            left: termToString(a),
            right: termToString(b),
            detail: `occurs-check 失败: 变量 ${v} 出现在 ${termToString(other)} 中`,
          });
          return {
            status: "failure",
            substitution: {},
            steps,
            solvedEquations: null,
            error: { code: "OCCURS_CHECK_FAILED", message: `变量 ${v} 出现在其绑定目标中（含间接链）` },
            algorithmVersion: ALGORITHM_VERSION,
          };
        }
        subst[v] = other;
        pushStep({
          equationIndex,
          kind: "bind",
          left: termToString(a),
          right: termToString(b),
          detail: `绑定 ${v} := ${termToString(other)}`,
        });
        continue;
      }

      if (a.type === "const" && b.type === "const") {
        pushStep({
          equationIndex,
          kind: "fail",
          left: termToString(a),
          right: termToString(b),
          detail: `常量冲突: ${a.name} 与 ${b.name}`,
        });
        return {
          status: "failure",
          substitution: {},
          steps,
          solvedEquations: null,
          error: { code: "UNIFICATION_FAILED", message: `常量 ${a.name} 与 ${b.name} 不同` },
          algorithmVersion: ALGORITHM_VERSION,
        };
      }

      if (a.type === "func" && b.type === "func" && a.name === b.name && a.args.length === b.args.length) {
        pushStep({
          equationIndex,
          kind: "decompose",
          left: termToString(a),
          right: termToString(b),
          detail: `分解 ${a.name}/${a.args.length} 为 ${a.args.length} 个子方程`,
        });
        for (let i = 0; i < a.args.length; i++) {
          queue.push({ left: a.args[i], right: b.args[i], equationIndex });
        }
        continue;
      }

      const reason =
        a.type === "func" && b.type === "func" && a.name === b.name
          ? `函数 ${a.name} 参数个数不一致: ${a.args.length} 与 ${(b as typeof a).args.length}`
          : `符号不匹配: ${termToString(a)} 与 ${termToString(b)}`;
      pushStep({ equationIndex, kind: "fail", left: termToString(a), right: termToString(b), detail: reason });
      return {
        status: "failure",
        substitution: {},
        steps,
        solvedEquations: null,
        error: { code: "UNIFICATION_FAILED", message: reason },
        algorithmVersion: ALGORITHM_VERSION,
      };
    }

    // 传递展开，保证幂等
    const expanded: Subst = {};
    for (const name of Object.keys(subst).sort()) {
      expanded[name] = applySubst(subst[name], subst, budgets);
    }
    const solvedEquations = equations.map((e) => ({
      left: applySubst(e.left, expanded, budgets),
      right: applySubst(e.right, expanded, budgets),
    }));
    return {
      status: "success",
      substitution: expanded,
      steps,
      solvedEquations,
      error: null,
      algorithmVersion: ALGORITHM_VERSION,
    };
  } catch (err) {
    if (err instanceof ApiError && err.code === "BUDGET_EXCEEDED") {
      return {
        status: "incomplete",
        substitution: {},
        steps,
        solvedEquations: null,
        error: { code: err.code, message: err.message },
        algorithmVersion: ALGORITHM_VERSION,
      };
    }
    throw err;
  }
}
