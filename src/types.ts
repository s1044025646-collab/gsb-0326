/**
 * 一阶有限项的显式 JSON 表示。
 * - 变量：   { "type": "var", "name": "X" }
 * - 常量/函数符号：{ "type": "sym", "name": "f", "args": [...] }
 *   args 为空数组表示零参数符号（常量）。
 */
export type Term = VarTerm | SymTerm;

export interface VarTerm {
  type: "var";
  name: string;
}

export interface SymTerm {
  type: "sym";
  name: string;
  args: Term[];
}

export interface Equation {
  /** 可选的人类可读标签，用于诊断定位。 */
  id?: string;
  lhs: Term;
  rhs: Term;
}

/** 资源预算上限，超出即返回资源错误，绝不产出截断结果。 */
export interface Limits {
  maxDepth: number;
  maxNodes: number;
  maxEquations: number;
  maxExpandedNodes: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxDepth: 64,
  maxNodes: 10_000,
  maxEquations: 1_000,
  maxExpandedNodes: 100_000,
};

export const ALGORITHM_VERSION = "robinson-unify-v1";

export type StepKind =
  | "bind"
  | "decompose"
  | "skip"
  | "alias"
  | "fail";

export interface Step {
  /** 从 1 开始的确定序号。 */
  seq: number;
  kind: StepKind;
  /** 触发该步骤的方程（对原方程的索引，从 0 开始；分解时指向来源方程）。 */
  equationIndex: number;
  equationId?: string;
  lhs: Term;
  rhs: Term;
  /** 人类可读中文说明。 */
  detail: string;
  /** bind/alias：被绑定的变量名。 */
  variable?: string;
  /** bind：绑定目标（已在当前替换下）。 */
  boundTo?: Term;
}

export type FailureCode =
  | "CONSTANT_MISMATCH"
  | "SYMBOL_ARITY_MISMATCH"
  | "OCCURS_CHECK"
  | "RESOURCE_LIMIT";

export interface Failure {
  code: FailureCode;
  equationIndex: number;
  equationId?: string;
  message: string;
}

/** 成功时的替换：变量名 -> 有限项（传递展开后，幂等）。 */
export type Substitution = Record<string, Term>;

export interface UnifySuccess {
  status: "success";
  substitution: Substitution;
  /** 原方程在最终替换下的结果（lhs 与 rhs 结构相同）。 */
  results: Array<{ equationIndex: number; equationId?: string; lhs: Term; rhs: Term }>;
  steps: Step[];
}

export interface UnifyFailure {
  status: "failure";
  failure: Failure;
  steps: Step[];
}

export type UnifyResult = UnifySuccess | UnifyFailure;

export interface ValidationIssue {
  code:
    | "INVALID_JSON"
    | "DUPLICATE_KEYS"
    | "NOT_OBJECT"
    | "MISSING_FIELD"
    | "BAD_TYPE_FIELD"
    | "BAD_NAME"
    | "BAD_ARGS"
    | "CONFLICTING_FIELDS"
    | "UNKNOWN_FIELD"
    | "DEPTH_EXCEEDED"
    | "NODES_EXCEEDED"
    | "EQUATIONS_EXCEEDED"
    | "BAD_EQUATION";
  message: string;
  path: string;
}
