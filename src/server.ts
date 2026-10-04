import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AnalysisService, ServiceError } from "./service.js";
import { DEFAULT_LIMITS } from "./types.js";
import { unify as runUnify } from "./unify.js";

interface RouteContext {
  service: AnalysisService;
  body: unknown;
  params: Record<string, string>;
  query: URLSearchParams;
}

type Handler = (ctx: RouteContext) => unknown | Promise<unknown>;

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
}

const routes: Route[] = [
  { method: "POST", parts: ["analyses"], handler: (c) => c.service.create({ input: c.body }) },
  { method: "POST", parts: ["analyses", "from", ":id"], handler: (c) => c.service.create({ input: c.body, parentId: c.params.id! }) },
  { method: "POST", parts: ["validate"], handler: (c) => c.service.validate(c.body).validated },
  { method: "POST", parts: ["unify"], handler: (c) => {
      const { validated, limits } = c.service.validate(c.body);
      if (validated.issues.length) throw new ServiceError("VALIDATION_FAILED", "输入校验失败", validated.issues);
      return runUnify(validated.equations, limits, validated.variables);
    },
  },
  { method: "GET", parts: ["analyses"], handler: (c) => c.service.list(Number(c.query.get("limit") ?? "50")) },
  { method: "GET", parts: ["analyses", ":id"], handler: (c) => c.service.get(c.params.id!) },
  { method: "GET", parts: ["analyses", ":id", "steps"], handler: (c) =>
      c.service.steps(
        c.params.id!,
        Number(c.query.get("offset") ?? "0"),
        Number(c.query.get("limit") ?? "20"),
      ),
  },
  { method: "POST", parts: ["analyses", ":id", "apply"], handler: (c) => {
      const term = (c.body as { term?: unknown }).term;
      if (!term) throw new ServiceError("MISSING_FIELD", "请求体需包含 term");
      return c.service.apply(c.params.id!, term as never);
    },
  },
  { method: "GET", parts: ["compare", ":a", ":b"], handler: (c) => c.service.compare(c.params.a!, c.params.b!) },
  { method: "GET", parts: ["analyses", ":id", "export"], handler: (c) => c.service.exportReport(c.params.id!) },
  { method: "GET", parts: ["health"], handler: () => ({ ok: true, algorithmVersion: "robinson-unify-v1", limits: DEFAULT_LIMITS }) },
];

function matchRoute(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
  const seg = pathname.split("/").filter(Boolean);
  for (const route of routes) {
    if (route.method !== method || route.parts.length !== seg.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    route.parts.forEach((p, i) => {
      if (p.startsWith(":")) params[p.slice(1)] = seg[i]!;
      else if (p !== seg[i]) ok = false;
    });
    if (ok) return { route, params };
  }
  return null;
}

export function startServer(service: AnalysisService, preferredPort?: number): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => void handle(req, res, service));
    server.on("error", reject);
    // 不传端口或端口为 0：由操作系统分配空闲端口。
    server.listen(preferredPort ?? 0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve({ server, port: addr.port });
      else reject(new Error("无法获取监听端口"));
    });
  });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 5_000_000) {
        reject(new ServiceError("PAYLOAD_TOO_LARGE", "请求体超过 5MB 限制"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new ServiceError("INVALID_JSON", `请求体不是合法 JSON: ${(err as Error).message}`));
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

async function handle(req: IncomingMessage, res: ServerResponse, service: AnalysisService): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const matched = matchRoute(req.method ?? "GET", url.pathname);
    if (!matched) {
      send(res, 404, { error: { code: "NOT_FOUND", message: `无此路由: ${req.method} ${url.pathname}` } });
      return;
    }
    const body = req.method === "POST" ? await readBody(req) : {};
    const result = await matched.route.handler({
      service,
      body,
      params: matched.params,
      query: url.searchParams,
    });
    send(res, 200, { data: result });
  } catch (err) {
    if (err instanceof ServiceError) {
      const status =
        err.code === "NOT_FOUND"
          ? 404
          : err.code === "NO_SUBSTITUTION"
            ? 409
            : err.code === "PAYLOAD_TOO_LARGE"
              ? 413
              : 400;
      send(res, status, { error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    send(res, 500, { error: { code: "INTERNAL", message: (err as Error).message } });
  }
}
