import * as fs from "node:fs";
import * as path from "node:path";
import { Store } from "./store";
import { runAnalysis, applyStoredSubst } from "./service";
import { DEFAULT_BUDGETS, termToString, validateTerm } from "./terms";
import { startServer } from "./server";

function dataDir(): string {
  return process.env.UNIFY_DATA_DIR ?? path.join(process.cwd(), "data");
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function flag(args: string[], name: string, def: string): string {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
}

function printAnalysis(id: number, store: Store): void {
  const row = store.get(id);
  console.log(`分析 #${row.id}  状态: ${row.status}  算法: ${row.algorithm_version}  时间: ${row.created_at}`);
  console.log("原方程:");
  row.equations.forEach((e, i) => console.log(`  [${i}] ${termToString(e.left)} = ${termToString(e.right)}`));
  if (row.status === "success" && row.substitution) {
    console.log("替换表:");
    for (const [k, v] of Object.entries(row.substitution)) {
      console.log(`  ${k} := ${termToString(v)}`);
    }
    console.log("处理后结构:");
    const { applySubst } = require("./terms");
    row.equations.forEach((e, i) => {
      const l = applySubst(e.left, row.substitution, DEFAULT_BUDGETS);
      const r = applySubst(e.right, row.substitution, DEFAULT_BUDGETS);
      console.log(`  [${i}] ${termToString(l)}  ≡  ${termToString(r)}`);
    });
  } else if (row.error) {
    console.log(`失败原因 [${row.error.code}]: ${row.error.message}`);
  }
  console.log(`步骤数: ${row.steps.length}（用 steps 命令分页查看）`);
}

function demo(store: Store): void {
  const v = (name: string) => ({ type: "var", name });
  const c = (name: string) => ({ type: "const", name });
  const f = (name: string, ...args: unknown[]) => ({ type: "func", name, args });
  const cases: Array<[string, unknown[]]> = [
    ["例1: f(X,a) 与 f(b,Y)", [{ left: f("f", v("X"), c("a")), right: f("f", c("b"), v("Y")) }]],
    ["例2: 共享变量一致 g(X,X) 与 g(a,a)", [{ left: f("g", v("X"), v("X")), right: f("g", c("a"), c("a")) }]],
    ["例3: 常量冲突 g(X,X) 与 g(a,b)", [{ left: f("g", v("X"), v("X")), right: f("g", c("a"), c("b")) }]],
    [
      "例4: 间接 occurs-check 失败 X=Y, Y=f(X)",
      [
        { left: v("X"), right: v("Y") },
        { left: v("Y"), right: f("f", v("X")) },
      ],
    ],
  ];
  for (const [title, equations] of cases) {
    console.log("=".repeat(60));
    console.log(title);
    const row = runAnalysis(store, { equations });
    printAnalysis(row.id, store);
  }
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const store = new Store(dataDir());
  try {
    switch (cmd) {
      case "serve": {
        const port = Number(flag(args, "--port", "0"));
        await startServer(store, port);
        return; // 保持进程
      }
      case "solve": {
        const row = runAnalysis(store, readJson(args[0]) as { equations?: unknown });
        printAnalysis(row.id, store);
        break;
      }
      case "validate": {
        const term = validateTerm((readJson(args[0]) as { term: unknown }).term, DEFAULT_BUDGETS);
        console.log(`合法: ${termToString(term)}`);
        break;
      }
      case "report":
        printAnalysis(Number(args[0]), store);
        break;
      case "steps": {
        const row = store.get(Number(args[0]));
        const offset = Number(flag(args, "--offset", "0"));
        const limit = Number(flag(args, "--limit", "20"));
        console.log(`步骤 ${offset}..${offset + limit - 1} / 共 ${row.steps.length}`);
        row.steps.slice(offset, offset + limit).forEach((s) => {
          console.log(`  #${s.index} [方程${s.equationIndex}] ${s.kind}: ${s.left} ~ ${s.right} -- ${s.detail}`);
        });
        break;
      }
      case "apply": {
        const r = applyStoredSubst(store, Number(args[0]), (readJson(args[1]) as { terms: unknown }).terms);
        r.terms.forEach((t) => console.log(termToString(t)));
        break;
      }
      case "export": {
        console.log(JSON.stringify(store.get(Number(args[0])), null, 2));
        break;
      }
      case "compare": {
        const a = store.get(Number(args[0]));
        const b = store.get(Number(args[1]));
        console.log(JSON.stringify({
          sameEquations: JSON.stringify(a.equations) === JSON.stringify(b.equations),
          sameSymbols: JSON.stringify(a.symbols) === JSON.stringify(b.symbols),
          sameSubstitution: JSON.stringify(a.substitution) === JSON.stringify(b.substitution),
        }, null, 2));
        break;
      }
      case "list":
        store.list().forEach((r) => console.log(`#${r.id}  ${r.status}  ${r.algorithm_version}  ${r.created_at}`));
        break;
      case "demo":
        demo(store);
        break;
      default:
        console.log(`用法: node dist/src/cli.js <命令>
  serve [--port N]     启动 API（默认自动选空闲端口）
  solve <file.json>    求解 {"equations":[{left,right},...]}
  validate <file.json> 校验 {"term":...}
  report <id>          查看分析（原方程/替换表/处理后结构）
  steps <id> [--offset N --limit M]  分页查看步骤
  apply <id> <file.json>  对 {"terms":[...]} 应用已保存替换
  export <id>          导出完整报告 JSON
  compare <idA> <idB>  比较两次输入
  list                 列出全部分析
  demo                 运行内置演示`);
    }
  } finally {
    if (process.argv.slice(2)[0] !== "serve") store.close();
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
