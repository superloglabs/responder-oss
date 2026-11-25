// Finds the name of the function that contains a position in source code,
// such as the original source in a source map. It reads braces and function
// heads rather than parsing, so braces inside strings or comments can mislead
// it; it then names no function rather than a wrong one where it can.

const ANONYMOUS = Symbol("anonymous");
const NOT_A_FUNCTION = Symbol("not a function");
const BLOCK_KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "with", "return", "typeof", "await", "yield", "new", "in", "of"]);
const IDENTIFIER = /[A-Za-z_$][\w$]*/;
// How far back a function head is read from its `{`, and how many enclosing
// blocks are tried. Real heads and nesting are far smaller; the bounds keep
// the work linear in the source's length.
const HEAD_SCAN_LIMIT = 10_000;
const BLOCK_LIMIT = 200;

function skipSpaceBack(source: string, index: number): number {
  const stop = index - HEAD_SCAN_LIMIT;
  while (index >= 0 && index > stop && /\s/.test(source[index]!)) index -= 1;
  return index;
}

// The index of the bracket that opens the one at `closeIndex`: -1 when there
// is none, TOO_FAR when it is further back than the scan reads.
const TOO_FAR = -2;

function matchingOpen(source: string, closeIndex: number, open: string, close: string): number {
  let depth = 0;
  for (let i = closeIndex; i >= 0; i -= 1) {
    if (i <= closeIndex - HEAD_SCAN_LIMIT) return TOO_FAR;
    if (source[i] === close) depth += 1;
    else if (source[i] === open && --depth === 0) return i;
  }
  return -1;
}

// The name a function expression or arrow function is assigned to, as in
// `name = () => {`, `name: function () {`, or `const name = async () => {`.
function assignedName(before: string): string | typeof ANONYMOUS {
  const assigned = before.match(/([A-Za-z_$][\w$]*)\s*(?:\??:[^=,;()]*)?\s*[:=]\s*(?:async\s*)?$/);
  return assigned?.[1] ?? ANONYMOUS;
}

// What opens the block at `braceIndex`: a function's name, an anonymous
// function, or another kind of block.
function functionHead(source: string, braceIndex: number): string | typeof ANONYMOUS | typeof NOT_A_FUNCTION {
  let end = skipSpaceBack(source, braceIndex - 1);
  if (source[end] === ">" && source[end - 1] === "=") {
    // An arrow function: `(a, b) => {` or `a => {`.
    let paramsEnd = skipSpaceBack(source, end - 2);
    // A TypeScript return type sits between the parameters and the arrow.
    const typed = source.slice(Math.max(0, paramsEnd - 200), paramsEnd + 1).match(/\)\s*:\s*[^()=]*$/);
    if (typed) paramsEnd = paramsEnd - typed[0].length + 1;
    const paramsStart = source[paramsEnd] === ")"
      ? matchingOpen(source, paramsEnd, "(", ")")
      : paramsEnd - (source.slice(Math.max(0, paramsEnd - 200), paramsEnd + 1).match(/[A-Za-z_$][\w$]*$/)?.[0].length ?? 0) + 1;
    if (paramsStart < 0) return ANONYMOUS;
    return assignedName(source.slice(Math.max(0, paramsStart - 200), paramsStart));
  }
  // A TypeScript return type: `): Promise<Cart> {`.
  const head = source.slice(Math.max(0, end - 300), end + 1);
  const returnType = head.match(/\)\s*:\s*[^(){};=]+$/);
  if (returnType) end = end - returnType[0].length + 1;
  if (source[end] !== ")") return NOT_A_FUNCTION;
  const paramsStart = matchingOpen(source, end, "(", ")");
  // A head too long to read names no function, rather than an outer one.
  if (paramsStart === TOO_FAR) return ANONYMOUS;
  if (paramsStart < 0) return NOT_A_FUNCTION;
  let before = source.slice(Math.max(0, paramsStart - 200), paramsStart).replace(/\s*<[^<>]*>\s*$/, "");
  const declared = before.match(/function\s*\*?\s*([A-Za-z_$][\w$]*)?\s*$/);
  if (declared) {
    if (declared[1]) return declared[1];
    before = before.slice(0, before.length - declared[0].length);
    return assignedName(before);
  }
  // A method: `load(id) {`, `async load(id) {`, `get total() {`.
  const method = before.match(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*$/);
  if (!method?.[1] || BLOCK_KEYWORDS.has(method[1])) return NOT_A_FUNCTION;
  return IDENTIFIER.test(method[1]) ? method[1] : NOT_A_FUNCTION;
}

// The innermost function around `offset` in `source`, or null when it is
// anonymous or none is found.
export function enclosingFunctionName(source: string, offset: number): string | null {
  let depth = 0;
  let blocks = 0;
  for (let i = Math.min(offset, source.length) - 1; i >= 0 && blocks < BLOCK_LIMIT; i -= 1) {
    const char = source[i];
    if (char === "}") depth += 1;
    else if (char === "{") {
      if (depth > 0) {
        depth -= 1;
        continue;
      }
      blocks += 1;
      const head = functionHead(source, i);
      if (head === NOT_A_FUNCTION) continue;
      return head === ANONYMOUS ? null : head;
    }
  }
  return null;
}
