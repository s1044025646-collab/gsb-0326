import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applySubstitution,
  assertIdempotent,
  formatTerm,
  termsEqual,
  unify,
} from "../src/unify.js";
import { validateEquations } from "../src/validate.js";
import { parseStrictJSON } from "../src/parse.js";
import { DEFAULT_LIMITS, type Equation, type Term } from "../src/types.js";
import { Store } from "../src/db.js";
import { AnalysisService } from "../src/service.js";

const varT = (name: string): Term => ({ type: "var", name });
const sym = (name: string, ...args: Term[]): Term => ({ type: "sym", name, args });

function run(eqs: Equation[]) {
  const vars = [...new Set(eqs.flatMap((e) => [...varsOf(e.lhs), ...varsOf(e.rhs)]))].sort();
  return unify(eqs, DEFAULT_LIMITS, vars);
}
function varsOf(t: Term, out = new Set<string>()): Set<string> {
  if (t.type === "var") out.add(t.name);
  else t.args.forEach((a) => varsOf(a, out));
  return out;
}

test("f(X,a) 与 f(b,Y) 手算得到 X=b, Y=a", () => {
  const r = run([{ lhs: sym("f", varT("X"), sym("a")), rhs: sym("f", sym("b"), varT("Y")) }]);
  assert.equal(r.status, "success");
  if (r.status !== "success") return;
  // 手算答案：两个参数位置分别给出 X=b、Y=a
  assert.deepEqual(r.substitution, { X: sym("b"), Y: sym("a") });
  assert.ok(termsEqual(r.results[0]!.lhs, sym("f", sym("b"), sym("a"))));
});

test("空方程组得到空替换", () => {
  const r = run([]);
  assert.equal(r.status, "success");
  if (r.status !== "success") return;
  assert.deepEqual(r.substitution, {});
  assert.ok(assertIdempotent(r.substitution, DEFAULT_LIMITS));
});

test("同变量等式 X=X 跳过", () => {
  const r = run([{ lhs: varT("X"), rhs: varT("X") }]);
  assert.equal(r.status, "success");
  if (r.status !== "success") return;
  assert.deepEqual(r.substitution, {});
  assert.ok(r.steps.some((s) => s.kind === "skip"));
});

test("零参数符号是常量：相同成功、不同失败", () => {
  const ok = run([{ lhs: sym("a"), rhs: sym("a") }]);
  assert.equal(ok.status, "success");
  const bad = run([{ lhs: sym("a"), rhs: sym("b") }]);
  assert.equal(bad.status, "failure");
  if (bad.status === "failure") assert.equal(bad.failure.code, "CONSTANT_MISMATCH");
});

test("长别名链被传递展开为幂等替换", () => {
  const r = run([
    { lhs: varT("A"), rhs: varT("B") },
    { lhs: varT("B"), rhs: varT("C") },
    { lhs: varT("C"), rhs: sym("k") },
  ]);
  assert.equal(r.status, "success");
  if (r.status !== "success") return;
  assert.deepEqual(r.substitution, { A: sym("k"), B: sym("k"), C: sym("k") });
  assert.ok(assertIdempotent(r.substitution, DEFAULT_LIMITS));
  // 应用两次 == 应用一次
  for (const name of ["A", "B", "C"]) {
    const once = applySubstitution(r.substitution, varT(name), DEFAULT_LIMITS);
    const twice = applySubstitution(r.substitution, once, DEFAULT_LIMITS);
    assert.ok(termsEqual(once, twice));
  }
});

test("嵌套分解 h(g(X),Y) = h(g(a),b)", () => {
  const r = run([
    {
      lhs: sym("h", sym("g", varT("X")), varT("Y")),
      rhs: sym("h", sym("g", sym("a")), sym("b")),
    },
  ]);
  assert.equal(r.status, "success");
  if (r.status !== "success") return;
  assert.deepEqual(r.substitution, { X: sym("a"), Y: sym("b") });
});

test("交换方程顺序得到相同替换", () => {
  const eqs: Equation[] = [
    { lhs: varT("X"), rhs: sym("a") },
    { lhs: sym("f", varT("X"), varT("Y")), rhs: sym("f", sym("a"), sym("b")) },
  ];
  const r1 = run(eqs);
  const r2 = run([...eqs].reverse());
  assert.equal(r1.status, "success");
  assert.equal(r2.status, "success");
  if (r1.status !== "success" || r2.status !== "success") return;
  assert.deepEqual(r1.substitution, r2.substitution);
});

test("变量一致改名得到同构结果", () => {
  const mk = (n: string) => [{ lhs: sym("f", varT(n)), rhs: sym("f", sym("a")) }];
  const r1 = run(mk("X"));
  const r2 = run(mk("Z"));
  assert.equal(r1.status, "success");
  assert.equal(r2.status, "success");
  if (r1.status !== "success" || r2.status !== "success") return;
  assert.deepEqual(r1.substitution, { X: sym("a") });
  assert.deepEqual(r2.substitution, { Z: sym("a") });
});

test("共享变量不一致：f(X,X)=f(a,b) 失败", () => {
  const r = run([{ lhs: sym("f", varT("X"), varT("X")), rhs: sym("f", sym("a"), sym("b")) }]);
  assert.equal(r.status, "failure");
  if (r.status === "failure") assert.equal(r.failure.code, "CONSTANT_MISMATCH");
});

test("间接 occurs-check：X=Y, Y=f(X) 失败", () => {
  const r = run([
    { lhs: varT("X"), rhs: varT("Y") },
    { lhs: varT("Y"), rhs: sym("f", varT("X")) },
  ]);
  assert.equal(r.status, "failure");
  if (r.status === "failure") assert.equal(r.failure.code, "OCCURS_CHECK");
});

test("直接 occurs-check：X=f(X) 失败", () => {
  const r = run([{ lhs: varT("X"), rhs: sym("f", varT("X")) }]);
  assert.equal(r.status, "failure");
  if (r.status !== "failure") return;
  assert.equal(r.failure.code, "OCCURS_CHECK");
});

test("函数名与元数冲突分别诊断", () => {
  const name = run([{ lhs: sym("f", sym("a")), rhs: sym("g", sym("a")) }]);
  assert.equal(name.status, "failure");
  if (name.status === "failure") assert.equal(name.failure.code, "CONSTANT_MISMATCH");
  const arity = run([{ lhs: sym("f", sym("a")), rhs: sym("f", sym("a"), sym("b")) }]);
  assert.equal(arity.status, "failure");
  if (arity.status === "failure") assert.equal(arity.failure.code, "SYMBOL_ARITY_MISMATCH");
});

test("无约束变量不随意绑定", () => {
  const r = run([
    { lhs: sym("f", varT("X"), varT("Z")), rhs: sym("f", sym("a"), varT("Z")) },
  ]);
  assert.equal(r.status, "success");
  if (r.status !== "success") return;
  assert.deepEqual(r.substitution, { X: sym("a") });
});

test("独立应用函数核对所有成功方程两侧相等且幂等", () => {
  const eqs: Equation[] = [
    { lhs: sym("p", varT("X"), varT("Y")), rhs: sym("p", sym("q", varT("Z")), sym("b")) },
    { lhs: varT("Z"), rhs: sym("c") },
  ];
  const r = run(eqs);
  assert.equal(r.status, "success");
  if (r.status !== "success") return;
  assert.ok(assertIdempotent(r.substitution, DEFAULT_LIMITS));
  for (const eq of eqs) {
    const a = applySubstitution(r.substitution, eq.lhs, DEFAULT_LIMITS);
    const b = applySubstitution(r.substitution, eq.rhs, DEFAULT_LIMITS);
    assert.ok(termsEqual(a, b), `替换后应相等: ${formatTerm(a)} vs ${formatTerm(b)}`);
  }
});

test("校验：非法节点、冲突字段、元数冲突、预算", () => {
  const badNode = validateEquations({ equations: [{ lhs: { type: "wat", name: "x" }, rhs: { type: "sym", name: "a", args: [] } }] }, DEFAULT_LIMITS);
  assert.ok(badNode.issues.some((i) => i.code === "BAD_TYPE_FIELD"));
  const conflict = validateEquations({ equations: [{ lhs: { type: "var", name: "X", args: [] }, rhs: { type: "var", name: "X" } }] }, DEFAULT_LIMITS);
  assert.ok(conflict.issues.some((i) => i.code === "CONFLICTING_FIELDS"));
  const arity = validateEquations({
    equations: [
      { lhs: { type: "sym", name: "f", args: [] }, rhs: { type: "sym", name: "a", args: [] } },
      { lhs: { type: "sym", name: "f", args: [{ type: "sym", name: "a", args: [] }] }, rhs: { type: "sym", name: "a", args: [] } },
    ],
  }, DEFAULT_LIMITS);
  assert.ok(arity.issues.some((i) => i.code === "BAD_ARGS"));
  const depth = validateEquations({ equations: [{ lhs: { type: "var", name: "X" }, rhs: { type: "var", name: "X" } }] }, { ...DEFAULT_LIMITS, maxDepth: 0 });
  assert.ok(depth.issues.some((i) => i.code === "DEPTH_EXCEEDED"));
});

test("严格 JSON 解析拒绝重复键", () => {
  const dup = parseStrictJSON('{"type":"var","type":"sym","name":"X"}');
  assert.ok(dup.issue);
  assert.equal(dup.issue!.code, "DUPLICATE_KEYS");
  const ok = parseStrictJSON('{"type":"var","name":"X"}');
  assert.ok(ok.value);
});

test("坏输入不会覆盖旧分析，成功分析可从数据库重新读取并应用替换", () => {
  const dir = mkdtempSync(join(tmpdir(), "unify-"));
  try {
    const dbPath = join(dir, "test.db");
    const store1 = new Store(dbPath);
    const svc1 = new AnalysisService(store1);
    const good = svc1.create({
      id: "FIXED-ID",
      input: { equations: [{ lhs: sym("f", varT("X")), rhs: sym("f", sym("a")) }] },
    });
    assert.equal(good.status, "success");

    // 同一服务上提交坏输入，应抛 VALIDATION_FAILED
    let badCode = "";
    try {
      svc1.create({ id: "FIXED-ID", input: { equations: [{ lhs: { type: "nope" }, rhs: null }] } });
    } catch (err) {
      badCode = (err as { code?: string }).code ?? "";
    }
    assert.equal(badCode, "VALIDATION_FAILED");
    store1.close();
    // 模拟重启：新建 Store 实例，从磁盘读取
    const store2 = new Store(dbPath);
    const svc2 = new AnalysisService(store2);
    const reloaded = svc2.get("FIXED-ID");
    assert.equal(reloaded.status, "success");
    const { term } = svc2.apply("FIXED-ID", sym("g", varT("X")));
    assert.ok(termsEqual(term, sym("g", sym("a"))));
    store2.close();
  } finally {
    rmForce(dir);
  }
});

test("新版本通过 parentId 关联，旧报告变量身份不变", () => {
  const dir = mkdtempSync(join(tmpdir(), "unify-"));
  try {
    const dbPath = join(dir, "ver.db");
    const store = new Store(dbPath);
    const svc = new AnalysisService(store);
    const v1 = svc.create({ id: "V1", input: { equations: [{ lhs: varT("X"), rhs: sym("a") }] } });
    const v2 = svc.create({
      id: "V2",
      parentId: "V1",
      input: { equations: [{ lhs: varT("X"), rhs: sym("b") }] },
    });
    assert.equal(v2.parentId, "V1");
    assert.deepEqual(v1.substitution, { X: sym("a") });
    assert.deepEqual(svc.get("V1").substitution, { X: sym("a") });
    assert.deepEqual(v2.substitution, { X: sym("b") });
    store.close();
  } finally {
    rmForce(dir);
  }
});

test("失败分析保存诊断但 substitution 为 null", () => {
  const dir = mkdtempSync(join(tmpdir(), "unify-"));
  try {
    const store = new Store(join(dir, "fail.db"));
    const svc = new AnalysisService(store);
    const rec = svc.create({ id: "F1", input: { equations: [{ lhs: varT("X"), rhs: sym("f", varT("X")) }] } });
    assert.equal(rec.status, "failure");
    assert.equal(rec.substitution, null);
    assert.ok(rec.failure);
    let applyCode = "";
    try {
      svc.apply("F1", varT("X"));
    } catch (err) {
      applyCode = (err as { code?: string }).code ?? "";
    }
    assert.equal(applyCode, "NO_SUBSTITUTION");
    store.close();
  } finally {
    rmForce(dir);
  }
});

test("变量与同名常量不混淆", () => {
  const r = run([{ lhs: varT("a"), rhs: sym("a") }]);
  assert.equal(r.status, "success");
  if (r.status !== "success") return;
  assert.deepEqual(r.substitution, { a: sym("a") });
});

function rmForce(dir: string, retries = 5): void {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      // Windows 下 SQLite 句柄释放可能有短暂延迟
      const waitUntil = Date.now() + 100;
      while (Date.now() < waitUntil) {}
    }
  }
}
