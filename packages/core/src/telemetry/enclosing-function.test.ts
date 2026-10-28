import { expect, test } from "vitest";
import { enclosingFunctionName } from "./enclosing-function.js";

function nameAt(source: string, marker = "HERE"): string | null {
  return enclosingFunctionName(source.replace(marker, ""), source.indexOf(marker));
}

test("enclosingFunctionName reads declarations, methods, and assigned functions", () => {
  expect(nameAt("function renderTotal(cart) {\n  if (cart) {\n    return HEREcart.total;\n  }\n}")).toBe("renderTotal");
  expect(nameAt("class Cart {\n  async load(id = f(), { a }) {\n    HEREfetch(id);\n  }\n}")).toBe("load");
  expect(nameAt("const submit = async (event) => {\n  HEREpay();\n};")).toBe("submit");
  expect(nameAt("const handlers = { onPay: function () { HEREpay(); } };")).toBe("onPay");
  expect(nameAt("window.reportHandled = function reportHandled() {\n  try {\n    HEREload();\n  } catch (e) {}\n};")).toBe("reportHandled");
  expect(nameAt("button.addEventListener('click', function onPay() { HEREpay(); });")).toBe("onPay");
});

test("enclosingFunctionName reads TypeScript signatures", () => {
  expect(nameAt("export function total<T extends Item>(items: T[]): number {\n  return HEREitems.length;\n}")).toBe("total");
  expect(nameAt("const load = async (id: string): Promise<Cart> => {\n  HEREfetch(id);\n};")).toBe("load");
  expect(nameAt("class A {\n  private async save(cart: Cart): Promise<void> {\n    HEREwrite(cart);\n  }\n}")).toBe("save");
});

test("enclosingFunctionName leaves anonymous callbacks unnamed", () => {
  expect(nameAt("function outer() {\n  items.forEach((item) => {\n    HEREitem.total;\n  });\n}")).toBeNull();
  expect(nameAt("setTimeout(function () { HEREtick(); }, 10);")).toBeNull();
});

test("enclosingFunctionName skips blocks that are not functions", () => {
  expect(nameAt("function pay() {\n  for (const x of xs) {\n    while (x) {\n      HEREx.go();\n    }\n  }\n}")).toBe("pay");
  expect(nameAt("const config = { nested: { HEREvalue: 1 } };")).toBeNull();
});
