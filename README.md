# Robinson 项合一与变量替换解释后端

纯本地运行的一阶有限项合一服务：TypeScript + Node.js + SQLite（`node:sqlite`，无原生依赖、无 Docker、无外部服务）。只做符号结构合一，**不执行函数、不解释算术、不做 Prolog 查询或定理证明**。

## 功能

- 自行实现 Robinson 合一：分解（decompose）、变量绑定、替换传播、occurs-check（含 `X=Y, Y=f(X)` 这类间接循环，拒绝无限项，不靠递归溢出当失败）。
- 确定性：方程按输入顺序 FIFO 处理；变量-变量绑定时字典序较大者绑定到较小者；同一输入必得同一结果。
- 返回的替换已**传递展开**（幂等：应用两次 = 应用一次），无别名链；未受约束的变量保持为变量，不与同名常量混淆。
- 每个分析记录完整步骤（分解 / 跳过相同项 / 绑定 / 失败及所在方程序号），可分页查看；可查看原方程应用最终替换后的结果。
- SQLite 持久化：原始方程、符号约定（名称 → 元数）、算法版本、最终替换、步骤摘要。失败分析只保存诊断，不发布半个替换；分析记录不可变，重启后可读取并应用已保存替换。
- 预算限制：项深度、总节点数、方程数、步骤数、替换展开大小。超预算返回 `incomplete`（明确错误），绝不把截断结果标成成功。

## 项的 JSON 表示

用显式 `type` 字段区分变量与符号，无需文本解析器：

```json
{ "type": "var",   "name": "X" }
{ "type": "const", "name": "a" }
{ "type": "func",  "name": "f", "args": [ { "type": "var", "name": "X" }, { "type": "const", "name": "a" } ] }
```

- 变量名 / 符号名：`[A-Za-z_][A-Za-z0-9_]*`。变量按名称在一次分析内共享身份。
- 零参数符号用 `const`（视为 0 元函数）；`func` 的 `args` 必须非空。
- 同一符号名在一次分析中元数必须一致，否则报 `ARITY_CONFLICT`。
- 节点只允许规定字段，多余字段报 `INVALID_TERM`。

## 最一般替换（MGU）与有限项

本服务返回的是 Robinson 意义下的**最一般合一替换（MGU）**：任何其他合一替换都可由它再实例化得到。所有项都是**有限项**——occurs-check 保证不会构造 `X = f(f(f(...)))` 这样的无限项；凡是会导致无限项的方程组一律以 `OCCURS_CHECK_FAILED` 失败并给出诊断。

## 预算范围（默认值，可在请求中覆盖）

| 预算 | 字段 | 默认 |
|---|---|---|
| 项最大深度 | `maxDepth` | 64 |
| 单组输入总节点 | `maxNodes` | 10000 |
| 方程数 | `maxEquations` | 1000 |
| 求解步骤数 | `maxSteps` | 100000 |
| 替换展开节点数 | `maxExpansionNodes` | 100000 |

超出任一预算：状态为 `incomplete`，错误码 `BUDGET_EXCEEDED`，不保存替换。

## 错误码

`INVALID_TERM`（非法节点）、`ARITY_CONFLICT`（元数冲突）、`UNIFICATION_FAILED`（常量/符号冲突）、`OCCURS_CHECK_FAILED`、`BUDGET_EXCEEDED`、`NOT_FOUND`、`BAD_REQUEST`。

## 构建 / 测试 / 启动 / 演示

```powershell
npm install
npm run build     # 编译到 dist/
npm test          # 编译并运行全部测试（node:test）
npm start         # 启动 API（默认自动选择空闲端口；--port N 指定端口）
npm run demo      # 内置演示：f(X,a)=f(b,Y)、共享变量、常量冲突、间接 occurs-check
```

数据保存在项目内 `data/` 目录（可用环境变量 `UNIFY_DATA_DIR` 覆盖）。

## CLI

```
node dist/src/cli.js serve [--port N]        启动 API（默认端口 0 = 自动选空闲端口）
node dist/src/cli.js solve <file.json>       求解 {"equations":[{"left":...,"right":...}]}
node dist/src/cli.js validate <file.json>    校验 {"term":...}
node dist/src/cli.js report <id>             原方程 + 替换表 + 处理后结构
node dist/src/cli.js steps <id> [--offset N --limit M]   分页查看步骤（分页不影响求解结果）
node dist/src/cli.js apply <id> <file.json>  对 {"terms":[...]} 应用已保存替换
node dist/src/cli.js export <id>             导出完整报告 JSON
node dist/src/cli.js compare <idA> <idB>     比较两次输入/替换是否一致
node dist/src/cli.js list                    列出全部分析
node dist/src/cli.js demo                    运行内置演示
```

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/analyses` | 创建并执行分析，body: `{"equations":[...], "budgets":{...}?}` |
| GET | `/analyses` | 列出全部分析 |
| GET | `/analyses/:id` | 读取报告 |
| GET | `/analyses/:id/steps?offset=&limit=` | 分页读取步骤 |
| POST | `/analyses/:id/apply` | 对 `{"terms":[...]}` 应用已保存替换 |
| GET | `/analyses/:id/export` | 导出完整报告（含可读方程） |
| GET | `/analyses/:id/compare/:otherId` | 比较两次分析 |
| POST | `/terms/validate` | 校验 `{"term":...}` |
| GET | `/health` | 健康检查 |

状态码：成功 200；合一失败 422；超预算 413；参数/结构错误 400；不存在 404。

## 演示示例

`npm run demo` 输出四个案例：

1. `f(X,a) = f(b,Y)` → `X := b, Y := a`
2. `g(X,X) = g(a,a)` → 共享变量一致，`X := a`
3. `g(X,X) = g(a,b)` → 常量冲突失败（`UNIFICATION_FAILED`）
4. `X = Y, Y = f(X)` → 间接 occurs-check 失败（`OCCURS_CHECK_FAILED`）

## 测试覆盖

空方程组、同变量等式、零参数符号、长别名链完全展开、嵌套分解、交换方程顺序结果一致、变量一致改名、直接与间接 occurs-check、共享变量一致/常量冲突、替换幂等性、用独立的替换应用函数核对每个成功方程确实相等、小例子手算答案比对、预算超限返回 `incomplete`、坏输入不覆盖旧分析、重启后读取并应用替换、失败分析不保存替换。

## 已知限制

- 仅符号结构合一：不做算术、约束求解、高阶项或带结合/交换律的等式理论。
- 替换展开按预算截断保护，极大项组（如指数级共享展开）会返回 `incomplete` 而非结果。
- 单进程本地服务，无鉴权，绑定 `127.0.0.1`。
- `node:sqlite` 在 Node 25 仍为实验特性（启动时有 ExperimentalWarning，不影响功能）。
