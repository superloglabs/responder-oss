import { describe, expect, it } from "vitest";
import { app } from "./app.js";

// Sentry's Hono integration traces each middleware as a span named after its
// function, and an arrow function's span reads "<anonymous>". It treats a
// route handler as middleware when another handler follows it on the same
// method and path, or when it runs for every method and takes `next`.
describe("middleware names", () => {
  it("names every middleware the application registers", () => {
    const lastByRoute = new Map<string, number>();
    app.routes.forEach((route, index) => lastByRoute.set(`${route.method} ${route.path}`, index));
    const unnamed = app.routes.flatMap((route, index) => {
      const handler = (route.handler as { __COMPOSED_HANDLER?: typeof route.handler }).__COMPOSED_HANDLER ?? route.handler;
      const middleware =
        lastByRoute.get(`${route.method} ${route.path}`) !== index ||
        (route.method === "ALL" && handler.length >= 2);
      return middleware && !handler.name ? [`${route.method} ${route.path}`] : [];
    });

    expect(unnamed).toEqual([]);
  });
});
