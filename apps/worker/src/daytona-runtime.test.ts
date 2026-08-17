import { describe, expect, it } from "vitest";

describe("Daytona sandbox runtime", () => {
  it("ships the optional SDK required by the OpenAI sandbox adapter", async () => {
    const { Daytona } = await import("@daytonaio/sdk");

    expect(Daytona).toBeTypeOf("function");
  });
});
