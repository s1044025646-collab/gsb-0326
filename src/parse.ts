import type { ValidationIssue } from "./types.js";

/**
 * 严格解析 JSON：拒绝同一对象内的重复键（例如两次出现 "type"），
 * 避免“重复字段含义”造成的歧义。
 */
export function parseStrictJSON(text: string): { value?: unknown; issue?: ValidationIssue } {
  let i = 0;
  const fail = (message: string): ValidationIssue => ({
    code: "INVALID_JSON",
    message: `JSON 语法错误: ${message}`,
    path: "$",
  });

  const skipWs = () => {
    while (i < text.length && /\s/.test(text[i]!)) i++;
  };

  const parseString = (): string => {
    i++;
    let out = "";
    while (i < text.length) {
      const ch = text[i]!;
      if (ch === '"') {
        i++;
        return out;
      }
      if (ch === "\\") {
        const esc = text[i + 1];
        if (esc === undefined) throw fail("不完整的转义序列");
        out += { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }[esc] ?? esc;
        i += 2;
        continue;
      }
      out += ch;
      i++;
    }
    throw fail("字符串未闭合");
  };

  const parseValue = (): unknown => {
    skipWs();
    const ch = text[i];
    if (ch === "{") return parseObject();
    if (ch === "[") return parseArray();
    if (ch === '"') return parseString();
    if (ch === "-" || (ch !== undefined && ch >= "0" && ch <= "9")) return parseNumber();
    if (text.startsWith("true", i)) {
      i += 4;
      return true;
    }
    if (text.startsWith("false", i)) {
      i += 5;
      return false;
    }
    if (text.startsWith("null", i)) {
      i += 4;
      return null;
    }
    throw fail(`意外字符 ${JSON.stringify(ch ?? "<结束>")}`);
  };

  const parseNumber = (): number => {
    const start = i;
    if (text[i] === "-") i++;
    while (i < text.length && /[0-9.eE+\-]/.test(text[i]!)) i++;
    const raw = text.slice(start, i);
    const num = Number(raw);
    if (Number.isNaN(num)) throw fail(`非法数字 ${raw}`);
    return num;
  };

  const parseObject = (): Record<string, unknown> => {
    i++;
    const obj: Record<string, unknown> = {};
    skipWs();
    if (text[i] === "}") {
      i++;
      return obj;
    }
    for (;;) {
      skipWs();
      if (text[i] !== '"') throw fail("对象键必须是字符串");
      const key = parseString();
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        throw { code: "DUPLICATE_KEYS", message: `对象内存在重复字段 "${key}"`, path: "$" } as ValidationIssue;
      }
      skipWs();
      if (text[i] !== ":") throw fail("对象键后缺少 ':'");
      i++;
      obj[key] = parseValue();
      skipWs();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "}") {
        i++;
        return obj;
      }
      throw fail("对象成员后应为 ',' 或 '}'");
    }
  };

  const parseArray = (): unknown[] => {
    i++;
    const arr: unknown[] = [];
    skipWs();
    if (text[i] === "]") {
      i++;
      return arr;
    }
    for (;;) {
      arr.push(parseValue());
      skipWs();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === "]") {
        i++;
        return arr;
      }
      throw fail("数组元素后应为 ',' 或 ']'");
    }
  };

  try {
    const value = parseValue();
    skipWs();
    if (i < text.length) throw fail("JSON 结束后仍有多余字符");
    return { value };
  } catch (err) {
    const issue = err as ValidationIssue;
    if (issue.code === "INVALID_JSON" || issue.code === "DUPLICATE_KEYS") return { issue };
    return { issue: fail((err as Error).message) };
  }
}
