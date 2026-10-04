# Robinson 项合一与变量替换解释后端

一个只做**后端**的一阶有限项合一（Robinson unification）分析服务，提供 HTTP API 与 CLI。
使用 **TypeScript + Node.js + SQLite**（Node 内置 `node:sqlite`，无原生编译依赖），
可在 Windows 本地直接运行：**不依赖 Docker、WSL、付费服务或任何在线 API**。

> 本服务只处理符号结构：不执行函数、不解释算术、不做 Prolog 查询、定理证明或通用编程语言。

## 基本概念

- **一阶有限项**：变量、常量（零参数符号）和带有序参数的函数项。项必须是有限的，拒绝无限项。
- **符号约定**：函数名与参数个数（元数）共同确定一个符号，`f/0`、`f/1`、`f/2` 是不同符号。
- **变量身份**：变量名在一次分析内共享身份；变量 `a` 与常量符号 `a` 是不同实体，互不混淆。
- **最一般替换（MGU, Most General Unifier）**：能让全部项对结构相等的、最不加限制的替换。
  本服务返回的替换经过**传递展开**：不存在需要调用者反复追踪的别名链，且**幂等**
  （应用一次与应用两次结果相同）。无约束的变量不会被随意绑定。

### 项的 JSON 表示（显式类型字段，无文本语法）

```jsonc
{ "type": "var", "name": "X" }                 // 变量
{ "type": "sym", "name": "a", "args": [] }     // 常量（零参数符号）
{ "type": "sym", "name": "f", "args": [ ... ] } // 函数项，参数有序
```

一次分析的输入：

```json
{ "equations": [ { "id": "e1", "lhs": { ... }, "rhs": { ... } } ] }
```

## 算法说明（确定性）

实现的是 Robinson 合一，待处理项对以**先进先出**队列处理，分解出的参数对按参数顺序追加到队尾；
两个不同变量需要别名时，**字典序较小者作为代表**。因此相同输入永远得到相同解释。

步骤类型：`decompose`（分解）、`bind`（绑定变量到项）、`alias`（变量别名）、`skip`（相同项跳过）、`fail`（失败）。

失败码：

- `CONSTANT_MISMATCH`：不同常量，或函数名不同。
- `SYMBOL_ARITY_MISMATCH`：同名符号参数个数不一致。
- `OCCURS_CHECK`：绑定变量前在**当前已生效替换**下发现变量出现在目标项中（无限项）。
  因此 `X=Y`、`Y=f(X)` 这样的**间接循环**同样会被拒绝，而不是只检查原始输入。
- `RESOURCE_LIMIT`：超出预算（见下）。

失败分析只保存诊断，`substitution` 为 `null`，绝不会发布半个成功替换。

## 预算范围（资源上限）

超过任一预算即返回 `400 VALIDATION_FAILED` 或合一结果 `failure/RESOURCE_LIMIT`，
不会产出截断的“成功”结果。默认上限（可在 `src/types.ts` 调整，API 健康检查中也可查看）：

| 预算 | 默认值 | 含义 |
| --- | --- | --- |
| `maxDepth` | 64 | 单个项的最大深度（根为 1） |
| `maxNodes` | 10 000 | 输入项的总节点数 |
| `maxEquations` | 1 000 | 一次分析的方程数量 |
| `maxExpandedNodes` | 100 000 | 合一解引用 / 应用替换时允许展开的节点数 |

校验还覆盖：非法节点、`type` 错误、`name` 非字符串、变量携带 `args`（重复/冲突字段含义）、
未知字段、符号元数冲突，以及请求体 JSON 同一对象内的**重复键**。

## 环境要求

- Node.js **22.5+ / 23+ / 25**（使用内置 `node:sqlite`；本机实测 Node v25.5.0）。
  启动时可能打印一条 `ExperimentalWarning: SQLite is an experimental feature`，不影响使用。
- Windows / macOS / Linux 均可，以下命令在 Windows PowerShell 中验证。

## 构建、测试、启动、演示

```powershell
npm install        # 安装 typescript 与 @types/node（仅开发依赖）
npm run build      # 编译到 dist/（src 与 test 同目录输出）
npm test           # 编译并运行 node:test 测试（20 个用例）
npm start          # 启动 HTTP API；默认自动选择空闲端口，控制台打印实际端口
npm run demo       # 运行内置演示（含成功、共享变量冲突、常量冲突、间接 occurs-check）
```

指定端口与数据库：`node dist/src/cli.js serve --port 7000 --db data/my.db`。
数据默认存放在项目内的 `data/unify.db`（SQLite 文件，自动创建）。

## CLI 用法

```powershell
node dist/src/cli.js validate examples/basic.json      # 仅校验
node dist/src/cli.js run examples/basic.json           # 执行合一并持久化
node dist/src/cli.js list                              # 列出分析
node dist/src/cli.js get <id>                          # 查看报告（原方程/替换表/处理后结构）
node dist/src/cli.js steps <id> --offset 0 --limit 10  # 分页查看解释（不改变求解结果）
node dist/src/cli.js apply <id> examples/term.json     # 对其他项应用已保存替换
node dist/src/cli.js compare <idA> <idB>               # 比较两次分析（变量一致改名）
node dist/src/cli.js run <file> --from <旧id>          # 基于旧分析创建新版本
```

重启进程后仍可用 `get`/`apply` 读取旧报告与应用已保存替换——全部从 SQLite 读取，不依赖进程内缓存。

## HTTP API

所有响应包裹为 `{ "data": ... }`，错误为 `{ "error": { "code", "message", "details" } }`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/validate` | 仅校验项结构，返回问题列表 / 符号约定 / 变量 |
| POST | `/unify` | 执行合一但不落库 |
| POST | `/analyses` | 校验 + 合一 + 持久化，返回完整报告 |
| POST | `/analyses/from/:id` | 以 `:id` 为父版本创建新版本 |
| GET | `/analyses` | 分析列表（`?limit=`） |
| GET | `/analyses/:id` | 读取报告 |
| GET | `/analyses/:id/steps` | 分页步骤（`?offset=&limit=`） |
| POST | `/analyses/:id/apply` | 体 `{"term": ...}`，应用已保存替换 |
| GET | `/compare/:a/:b` | 比较两次分析（成功判变量一致改名同构；失败判失败码） |
| GET | `/analyses/:id/export` | 导出整份报告 JSON |
| GET | `/health` | 健康检查、算法版本、当前预算 |

错误码：`VALIDATION_FAILED`(400)、`INVALID_JSON`(400)、`NOT_FOUND`(404)、
`NO_SUBSTITUTION`(409，对失败分析应用替换)、`PAYLOAD_TOO_LARGE`(413)、
`RESOURCE_LIMIT`(400)、`INTERNAL`(500)。

快速体验：

```powershell
node dist/src/cli.js serve
# 另开一个终端：
curl.exe -X POST http://127.0.0.1:<端口>/analyses -H "content-type: application/json" `
  --data "@examples/basic.json"
```

## 持久化与版本

SQLite 表 `analyses` 保存：原始方程、符号约定、变量列表、算法版本（`robinson-unify-v1`）、
最终替换（失败时为 `NULL`）、失败诊断与步骤摘要、预算参数。
修改输入请通过新版本（`--from` / `/analyses/from/:id`）创建；旧报告不被覆盖，
始终按其自身保存的变量身份与原方程解释。

## 演示用例的手算结果

- `f(X,a) = f(b,Y)` ⇒ `{X ↦ b, Y ↦ a}`，应用后两侧均为 `f(b,a)`。
- `f(X,X) = f(a,b)` ⇒ 失败：先 `X ↦ a`，随后要求 `a = b`，常量冲突。
- `a = b` ⇒ 失败：常量冲突。
- `X = Y, Y = f(X)` ⇒ 失败：`X` 经别名 `Y` 出现在 `f(X)` 中，间接 occurs-check。

## 范围与假设

- 只做合一分析与替换应用；没有文本语言/解析器（输入必须是上述 JSON）。
- 无内建类型、数字运算或求值；符号名只是字符串。
- 比较接口的“等价”指存在一个变量重命名使两方程组同构，符号名本身不重命名。
- `id` 未提供时自动生成；也可显式指定（测试/可复现场景使用）。

