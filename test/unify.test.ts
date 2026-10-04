import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_BUDGETS,
  Subst,
  Term,
  applySubst,
  termEqual,
  validateTerm,
} from "../src/terms";
import { Equation, unify } from "../src/unify";
import { Store } from "../src/store";
import { runAnalysis } from "../src/service";

const v = (name: string): Term => ({ type: "var", name });
const c = (name: string): Term => ({ type: "const", name });
const f = (name: string, ...args: Term[]): Term => ({ type: "func", name, args });
const eq = (left: Term, right: Term): Equation => ({ left, right });

function checkAllSolved(equations: Equation[], subst: Subst): void {
  for (const e of equations) {
    const l = applySubst(e.left, subst, DEFAULT_BUDGETS);
    const r = applySubst(e.right, subst, DEFAULT_BUDGETS);
    assert.ok(termEqual(l, r), `方程未满足: ${JSON.stringify(l)} vs ${JSON.stringify(r)}`);
  }
}

function checkIdempotent(equations: Equation[], subst: Subst): void {
  for (const e of equations) {
    const once = applySubst(e.left, subst, DEFAULT_BUDGETS);
    const twice = applySubst(once, subst, DEFAULT_BUDGETS);
    assert.ok(termEqual(once, twice), "替换不幂等");
  }
}

test("f(X,a) 与 f(b,Y) -> X=b, Y=a（手算答案）", () => {
  const eqs = [eq(f("f", v("X"), c("a")), f("f", c("b"), v("Y")))];
  const r = unify(eqs, DEFAULT_BUDGETS);
  assert.equal(r.status, "success");
  assert.deepEqual(r.substitution, {
    X: { type: "const", name: "b" },
    Y: { type: "const", name: "a" },
  });
  checkAllSolved(eqs, r.substitution);
  checkIdempotent(eqs, r.substitution);
});

test("空方程组成功且替换为空", () => {
  const r = unify([], DEFAULT_BUDGETS);
  assert.equal(r.status, "success");
  assert.deepEqual(r.substitution, {});
});

test("同变量等式 X=X 直接跳过", () => {
  const r = unify([eq(v("X"), v("X"))], DEFAULT_BUDGETS);
  assert.equal(r.status, "success");
  assert.deepEqual(r.substitution, {});
  assert.equal(r.steps[0].kind, "skip-identical");
});

test("零参数符号（常量）相同可合一，不同失败", () => {
  assert.equal(unify([eq(c("a"), c("a"))], DEFAULT_BUDGETS).status, "success");
  const r = unify([eq(c("a"), c("b"))], DEFAULT_BUDGETS);
  assert.equal(r.status, "failure");
  assert.equal(r.error?.code, "UNIFICATION_FAILED");
});

test("长别名链 X=Y,Y=Z,Z=W,W=a 完全展开", () => {
  const eqs = [
    eq(v("X"), v("Y")),
    eq(v("Y"), v("Z")),
    eq(v("Z"), v("W")),
    eq(v("W"), c("a")),
  ];
  const r = unify(eqs, DEFAULT_BUDGETS);
  assert.equal(r.status, "success");
  // 手算：所有变量最终都是 a
  for (const name of ["X", "Y", "Z", "W"]) {
    assert.deepEqual(r.substitution[name], { type: "const", name: "a" }, `${name} 应展开为 a`);
  }
  checkAllSolved(eqs, r.substitution);
  checkIdempotent(eqs, r.substitution);
});

test("嵌套分解 f(g(X),h(Y,Z)) 与 f(g(a),h(b,c))", () => {
  const eqs = [eq(f("f", f("g", v("X")), f("h", v("Y"), v("Z"))), f("f", f("g", c("a")), f("h", c("b"), c("c"))))];
  const r = unify(eqs, DEFAULT_BUDGETS);
  assert.equal(r.status, "success");
  assert.deepEqual(r.substitution, {
    X: { type: "const", name: "a" },
    Y: { type: "const", name: "b" },
    Z: { type: "const", name: "c" },
  });
  assert.ok(r.steps.some((s) => s.kind === "decompose"));
  checkAllSolved(eqs, r.substitution);
});

test("交换方程顺序结果一致（确定性）", () => {
  const a = [eq(v("X"), c("a")), eq(v("Y"), f("f", v("X")))];
  const b = [eq(v("Y"), f("f", v("X"))), eq(v("X"), c("a"))];
  const ra = unify(a, DEFAULT_BUDGETS);
  const rb = unify(b, DEFAULT_BUDGETS);
  assert.equal(ra.status, "success");
  assert.equal(rb.status, "success");
  assert.deepEqual(ra.substitution, rb.substitution);
  assert.deepEqual(ra.substitution, {
    X: { type: "const", name: "a" },
    Y: { type: "func", name: "f", args: [{ type: "const", name: "a" }] },
  });
});

test("变量一致改名不改变替换结构", () => {
  const r1 = unify([eq(f("f", v("X"), c("a")), f("f", c("b"), v("Y")))], DEFAULT_BUDGETS);
  const r2 = unify([eq(f("f", v("P"), c("a")), f("f", c("b"), v("Q")))], DEFAULT_BUDGETS);
  const shape = (s: Subst) => Object.values(s).map((t) => JSON.stringify(t)).sort();
  assert.deepEqual(shape(r1.substitution), shape(r2.substitution));
});

test("间接 occurs-check: X=Y, Y=f(X) 失败", () => {
  const r = unify([eq(v("X"), v("Y")), eq(v("Y"), f("f", v("X")))], DEFAULT_BUDGETS);
  assert.equal(r.status, "failure");
  assert.equal(r.error?.code, "OCCURS_CHECK_FAILED");
});

test("直接 occurs-check: X=f(X) 失败", () => {
  const r = unify([eq(v("X"), f("f", v("X")))], DEFAULT_BUDGETS);
  assert.equal(r.status, "failure");
  assert.equal(r.error?.code, "OCCURS_CHECK_FAILED");
});

test("共享变量一致 g(X,X)=g(a,a) 成功；g(X,X)=g(a,b) 常量冲突", () => {
  const ok = unify([eq(f("g", v("X"), v("X")), f("g", c("a"), c("a")))], DEFAULT_BUDGETS);
  assert.equal(ok.status, "success");
  assert.deepEqual(ok.substitution, { X: { type: "const", name: "a" } });
  const bad = unify([eq(f("g", v("X"), v("X")), f("g", c("a"), c("b")))], DEFAULT_BUDGETS);
  assert.equal(bad.status, "failure");
  assert.equal(bad.error?.code, "UNIFICATION_FAILED");
});

test("函数名不同 / 元数不同失败", () => {
  assert.equal(unify([eq(f("f", c("a")), f("g", c("a")))], DEFAULT_BUDGETS).status, "failure");
  assert.equal(unify([eq(f("f", c("a")), f("f", c("a"), c("b")))], DEFAULT_BUDGETS).status, "failure");
});

test("无约束变量不绑定常量", () => {
  const r = unify([eq(v("X"), f("f", v("Y")))], DEFAULT_BUDGETS);
  assert.equal(r.status, "success");
  assert.deepEqual(r.substitution, { X: { type: "func", name: "f", args: [{ type: "var", name: "Y" }] } });
});

test("预算超限返回 incomplete 而非成功", () => {
  const eqs = [eq(f("f", v("X"), v("Y")), f("f", c("a"), c("b")))];
  const r = unify(eqs, { ...DEFAULT_BUDGETS, maxSteps: 1 });
  assert.equal(r.status, "incomplete");
  assert.equal(r.error?.code, "BUDGET_EXCEEDED");
  assert.deepEqual(r.substitution, {});
});

test("深度超限", () => {
  let t: Term = c("a");
  for (let i = 0; i < 70; i++) t = f("f", t);
  const r = unify([eq(v("X"), t)], { ...DEFAULT_BUDGETS, maxDepth: 64 });
  // unify 本身不校验深度；校验在 validateTerm。这里验证 validateTerm 拒绝。
  assert.throws(() => validateTerm(t, { ...DEFAULT_BUDGETS, maxDepth: 64 }), /深度/);
  void r;
});

test("非法节点被拒绝", () => {
  assert.throws(() => validateTerm({ type: "var", name: "X", extra: 1 }, DEFAULT_BUDGETS), /字段/);
  assert.throws(() => validateTerm({ type: "func", name: "f", args: [] }, DEFAULT_BUDGETS), /非空/);
  assert.throws(() => validateTerm({ type: "wat", name: "x" }, DEFAULT_BUDGETS), /未知/);
  assert.throws(() => validateTerm({ type: "var", name: "1bad" }, DEFAULT_BUDGETS), /非法变量名/);
});

test("元数冲突检测", () => {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "unify-")));
  assert.throws(
    () => runAnalysis(store, { equations: [eq(f("f", c("a")), f("f", c("a"), c("b")))] }),
    /元数冲突/,
  );
  store.close();
});

test("坏输入不覆盖旧分析；重启后可读取并应用替换", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unify-"));
  const store1 = new Store(dir);
  const row = runAnalysis(store1, {
    equations: [eq(f("f", v("X"), c("a")), f("f", c("b"), v("Y")))],
  });
  assert.equal(row.status, "success");
  const countBefore = store1.list().length;
  assert.throws(() => runAnalysis(store1, { equations: [{ left: { type: "bad" }, right: c("a") }] }));
  assert.equal(store1.list().length, countBefore, "坏输入不应产生新记录");
  store1.close();

  // 模拟重启：新 Store 实例读取同一数据目录
  const store2 = new Store(dir);
  const loaded = store2.get(row.id);
  assert.equal(loaded.status, "success");
  const out = applySubst(v("X"), loaded.substitution!, DEFAULT_BUDGETS);
  assert.deepEqual(out, { type: "const", name: "b" });
  store2.close();
});

test("失败分析不保存替换", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "unify-"));
  const store = new Store(dir);
  const row = runAnalysis(store, { equations: [eq(c("a"), c("b"))] });
  assert.equal(row.status, "failure");
  assert.equal(row.substitution, null);
  store.close();
});
