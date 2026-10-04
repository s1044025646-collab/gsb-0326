import * as http from "node:http";
import { ApiError, DEFAULT_BUDGETS, termToString, validateTerm } from "./terms";
import { Store } from "./store";
import { applyStoredSubst, runAnalysis } from "./service";

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) {
        reject(new ApiError("BUDGET_EXCEEDED", "请求体超过 5MB"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new ApiError("BAD_REQUEST", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/health") {
        return send(res, 200, { ok: true });
      }

      if (method === "POST" && url.pathname === "/analyses") {
        const body = (await readBody(req)) as { equations?: unknown; budgets?: unknown };
        const row = runAnalysis(store, body);
        return send(res, row.status === "success" ? 200 : row.status === "failure" ? 422 : 413, row);
      }

      if (method === "GET" && url.pathname === "/analyses") {
        return send(res, 200, { analyses: store.list() });
      }

      if (method === "POST" && url.pathname === "/terms/validate") {
        const body = (await readBody(req)) as { term?: unknown };
        if (!("term" in body)) throw new ApiError("BAD_REQUEST", "缺少 term 字段");
        const term = validateTerm(body.term, DEFAULT_BUDGETS);
        return send(res, 200, { valid: true, term, pretty: termToString(term) });
      }

      if (parts[0] === "analyses" && parts.length >= 2) {
        const id = Number(parts[1]);
        if (!Number.isInteger(id)) throw new ApiError("BAD_REQUEST", "id 必须是整数");

        if (method === "GET" && parts.length === 2) {
          return send(res, 200, store.get(id));
        }
        if (method === "GET" && parts[2] === "steps") {
          const row = store.get(id);
          const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
          const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
          return send(res, 200, {
            id,
            total: row.steps.length,
            offset,
            limit,
            steps: row.steps.slice(offset, offset + limit),
          });
        }
        if (method === "POST" && parts[2] === "apply") {
          const body = (await readBody(req)) as { terms?: unknown };
          return send(res, 200, applyStoredSubst(store, id, body.terms));
        }
        if (method === "GET" && parts[2] === "export") {
          const row = store.get(id);
          return send(res, 200, {
            ...row,
            equationsPretty: row.equations.map((e) => `${termToString(e.left)} = ${termToString(e.right)}`),
          });
        }
        if (method === "GET" && parts[2] === "compare" && parts.length === 4) {
          const otherId = Number(parts[3]);
          if (!Number.isInteger(otherId)) throw new ApiError("BAD_REQUEST", "otherId 必须是整数");
          const a = store.get(id);
          const b = store.get(otherId);
          return send(res, 200, {
            idA: id,
            idB: otherId,
            sameEquations: JSON.stringify(a.equations) === JSON.stringify(b.equations),
            sameSymbols: JSON.stringify(a.symbols) === JSON.stringify(b.symbols),
            sameSubstitution: JSON.stringify(a.substitution) === JSON.stringify(b.substitution),
            statusA: a.status,
            statusB: b.status,
          });
        }
      }

      throw new ApiError("NOT_FOUND", `${method} ${url.pathname} 不存在`);
    } catch (err) {
      if (err instanceof ApiError) {
        const status =
          err.code === "NOT_FOUND" ? 404
          : err.code === "BUDGET_EXCEEDED" ? 413
          : err.code === "UNIFICATION_FAILED" || err.code === "OCCURS_CHECK_FAILED" ? 422
          : 400;
        return send(res, status, { error: { code: err.code, message: err.message, details: err.details ?? null } });
      }
      return send(res, 500, { error: { code: "INTERNAL", message: String(err) } });
    }
  });
}

export function startServer(store: Store, port: number): Promise<number> {
  const server = createServer(store);
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const actual = typeof addr === "object" && addr ? addr.port : port;
      console.log(`API 服务已启动: http://127.0.0.1:${actual}`);
      resolve(actual);
    });
  });
}
