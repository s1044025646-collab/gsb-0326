#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "./db.js";
import { AnalysisService, ServiceError } from "./service.js";
import { startServer } from "./server.js";
import { applySubstitution, formatTerm } from "./unify.js";
import { validateJSONText } from "./validate.js";
import { DEFAULT_LIMITS, type Equation, type Term } from "./types.js";

const DATA_DIR = resolve(process.cwd(), "data");
const DB_PATH = resolve(DATA_DIR, "unify.db");

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), "utf-8"));
}

function getService(dbPath = DB_PATH): { service: AnalysisService; store: Store } {
  const store = new Store(dbPath);
  return { service: new AnalysisService(store), store };
}

function printEquation(eq: Equation, idx: number): string {
  const label = eq.id ? `${eq.id} (#${idx})` : `#${idx}`;
  return `  [${label}]  ${formatTerm(eq.lhs)}  =  ${formatTerm(eq.rhs)}`;
}

function printReport(rec: ReturnType<AnalysisService["get"]>): void {
  console.log(`\n分析 ID:   ${rec.id}`);
  console.log(`创建时间:  ${rec.createdAt}`);
  console.log(`算法版本:  ${rec.algorithmVersion}`);
  console.log(`基于父版:  ${rec.parentId ?? "无（全新分析）"}`);
  console.log(`符号约定:  ${Object.entries(rec.signatures).map(([n, a]) => `${n}/${a.join("/")}`).join("  ") || "（无）"}`);
  console.log("原方程:");
  rec.equations.forEach((eq, i) => console.log(printEquation(eq, i)));

  if (rec.status === "success" && rec.substitution) {
    const entries = Object.entries(rec.substitution);
    console.log("\n结果: 成功 —— 最一般替换（已传递展开，幂等）:");
    if (entries.length === 0) {
      console.log("  （空替换：方程天然相等或无约束变量）");
    } else {
      for (const [name, term] of entries) console.log(`  ${name} := ${formatTerm(term)}`);
    }
    const free = rec.variables.filter((x) => !(x in rec.substitution!));
    if (free.length) console.log(`未绑定变量（保持原样）: ${free.join(", ")}`);
  } else if (rec.failure) {
    console.log(`\n结果: 失败 [${rec.failure.code}]`);
    console.log(`  ${rec.failure.message}`);
    if (rec.failure.equationIndex >= 0) {
      const eq = rec.equations[rec.failure.equationIndex];
      if (eq) console.log(`  发生于 ${printEquation(eq, rec.failure.equationIndex).trim()}`);
    }
    console.log("（失败分析保存了诊断，但不发布任何替换）");
  }
}

function printResults(rec: ReturnType<AnalysisService["get"]>): void {
  if (rec.status !== "success") return;
  console.log("\n处理后的结构（应用已保存替换）:");
  rec.equations.forEach((eq, i) => {
    const lhs = applySubstitution(rec.substitution!, eq.lhs, rec.limits);
    const rhs = applySubstitution(rec.substitution!, eq.rhs, rec.limits);
    console.log(`  #${i}  ${formatTerm(lhs)}  =  ${formatTerm(rhs)}`);
  });
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const dbPath = typeof args.flags.db === "string" ? resolve(args.flags.db) : DB_PATH;

  switch (command) {
    case "serve": {
      const port = args.flags.port ? Number(args.flags.port) : undefined;
      const { service, store } = getService(dbPath);
      const { port: actual } = await startServer(service, port);
      console.log(`Robinson 合一服务已启动: http://127.0.0.1:${actual}`);
      console.log(`数据库: ${dbPath}`);
      console.log("按 Ctrl+C 停止。");
      process.on("SIGINT", () => {
        store.close();
        process.exit(0);
      });
      break;
    }

    case "validate": {
      const file = args.positional[0] ?? (args.flags.file as string);
      if (!file) throw new ServiceError("USAGE", "用法: validate <equations.json>");
      const text = readFileSync(resolve(file), "utf-8");
      const { issues } = validateJSONText(text, DEFAULT_LIMITS);
      if (issues.length) {
        console.log("校验未通过:");
        issues.forEach((iss) => console.log(`  [${iss.code}] ${iss.path}: ${iss.message}`));
        process.exitCode = 1;
      } else {
        console.log("校验通过。");
      }
      break;
    }

    case "run":
    case "unify": {
      const file = args.positional[0] ?? (args.flags.file as string);
      if (!file) throw new ServiceError("USAGE", "用法: run <equations.json> [--from <id>]");
      const input = readJsonFile(file);
      const { service, store } = getService(dbPath);
      const rec = service.create({ input, parentId: args.flags.from as string | undefined });
      printReport(rec);
      printResults(rec);
      store.close();
      break;
    }

    case "list": {
      const { service, store } = getService(dbPath);
      const rows = service.list();
      if (rows.length === 0) console.log("（暂无分析）");
      rows.forEach((r) => console.log(`  ${r.id}  ${r.status.padEnd(7)} ${r.createdAt}${r.parentId ? `  <- ${r.parentId}` : ""}`));
      store.close();
      break;
    }

    case "get":
    case "export": {
      const id = args.positional[0];
      if (!id) throw new ServiceError("USAGE", "用法: get <id>");
      const { service, store } = getService(dbPath);
      const rec = service.get(id);
      if (args.flags.json) {
        console.log(JSON.stringify(rec, null, 2));
      } else {
        printReport(rec);
        printResults(rec);
      }
      store.close();
      break;
    }

    case "steps": {
      const id = args.positional[0];
      if (!id) throw new ServiceError("USAGE", "用法: steps <id> [--offset 0] [--limit 20]");
      const { service, store } = getService(dbPath);
      const page = service.steps(
        id,
        Number(args.flags.offset ?? "0"),
        Number(args.flags.limit ?? "20"),
      );
      console.log(`步骤 ${page.offset + 1}-${Math.min(page.offset + page.steps.length, page.total)} / 共 ${page.total} 条（分页不影响求解结果）`);
      for (const s of page.steps) {
        console.log(`  ${String(s.seq).padStart(3)}. [${s.kind.padEnd(9)}] ${s.detail}`);
      }
      store.close();
      break;
    }

    case "apply": {
      const id = args.positional[0];
      const file = args.positional[1] ?? (args.flags.file as string);
      if (!id || !file) throw new ServiceError("USAGE", "用法: apply <id> <term.json>");
      const term = readJsonFile(file) as Term;
      const { service, store } = getService(dbPath);
      const { term: out } = service.apply(id, term);
      console.log(`  ${formatTerm(term)}  =>  ${formatTerm(out)}`);
      store.close();
      break;
    }

    case "compare": {
      const [a, b] = args.positional;
      if (!a || !b) throw new ServiceError("USAGE", "用法: compare <idA> <idB>");
      const { service, store } = getService(dbPath);
      const result = service.compare(a, b);
      console.log(result.equivalent ? "两次分析在变量一致改名下等价。" : `不等价：${result.reason}`);
      if (result.renaming && Object.keys(result.renaming).length) {
        console.log("变量改名:", Object.entries(result.renaming).map(([k, v]) => `${k} -> ${v}`).join(", "));
      }
      store.close();
      break;
    }

    case "demo":
      await runDemo(dbPath);
      break;

    default:
      console.log(`Robinson 合一后端 CLI

用法:
  node dist/cli.js serve [--port 7000] [--db path.db]   启动 HTTP API（默认自动选空闲端口）
  node dist/cli.js validate <equations.json>            仅校验项结构
  node dist/cli.js run <equations.json> [--from <id>]   执行合一并存为新分析/新版本
  node dist/cli.js list                                 列出分析
  node dist/cli.js get <id> [--json]                    查看报告（含替换表与处理后结构）
  node dist/cli.js steps <id> [--offset 0] [--limit 20] 分页查看解释步骤
  node dist/cli.js apply <id> <term.json>               对其他项应用已保存替换
  node dist/cli.js compare <idA> <idB>                  比较两次分析（变量一致改名）
  node dist/cli.js demo                                 运行内置演示

数据目录默认: ${DATA_DIR}`);
  }
}

const DEMO_CASES: Array<{ title: string; equations: Equation[] }> = [
  {
    title: "1) f(X,a) = f(b,Y)  →  X=b, Y=a",
    equations: [
      {
        lhs: { type: "sym", name: "f", args: [{ type: "var", name: "X" }, { type: "sym", name: "a", args: [] }] },
        rhs: { type: "sym", name: "f", args: [{ type: "sym", name: "b", args: [] }, { type: "var", name: "Y" }] },
      },
    ],
  },
  {
    title: "2) 共享变量必须一致: f(X,X) = f(a,b) 失败",
    equations: [
      {
        id: "shared",
        lhs: { type: "sym", name: "f", args: [{ type: "var", name: "X" }, { type: "var", name: "X" }] },
        rhs: { type: "sym", name: "f", args: [{ type: "sym", name: "a", args: [] }, { type: "sym", name: "b", args: [] }] },
      },
    ],
  },
  {
    title: "3) 常量冲突: a = b 失败",
    equations: [
      { lhs: { type: "sym", name: "a", args: [] }, rhs: { type: "sym", name: "b", args: [] } },
    ],
  },
  {
    title: "4) 间接 occurs-check: X=Y, Y=f(X) 失败",
    equations: [
      { id: "e1", lhs: { type: "var", name: "X" }, rhs: { type: "var", name: "Y" } },
      { id: "e2", lhs: { type: "var", name: "Y" }, rhs: { type: "sym", name: "f", args: [{ type: "var", name: "X" }] } },
    ],
  },
  {
    title: "5) 长别名链 + 嵌套分解（成功）",
    equations: [
      { lhs: { type: "var", name: "A" }, rhs: { type: "var", name: "B" } },
      { lhs: { type: "var", name: "B" }, rhs: { type: "var", name: "C" } },
      {
        lhs: { type: "sym", name: "g", args: [{ type: "var", name: "C" }] },
        rhs: { type: "sym", name: "g", args: [{ type: "sym", name: "c", args: [] }] },
      },
    ],
  },
];

async function runDemo(dbPath: string): Promise<void> {
  const { service, store } = getService(dbPath);
  const ids: string[] = [];
  for (const c of DEMO_CASES) {
    console.log("\n========================================");
    console.log(c.title);
    const rec = service.create({ input: { equations: c.equations } });
    ids.push(rec.id);
    printReport(rec);
    printResults(rec);
  }
  console.log("\n演示完成，已保存分析:", ids.join(", "));
  store.close();
}

main().catch((err: unknown) => {
  if (err instanceof ServiceError) {
    console.error(`错误 [${err.code}]: ${err.message}`);
    if (err.details) console.error(JSON.stringify(err.details, null, 2));
  } else {
    console.error("错误:", (err as Error).stack ?? err);
  }
  process.exit(1);
});
