import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { expect, it } from "vitest";
import { subscriptionLoginRunner } from "./subscription-login.js";

it("drives managed app-server sign-in and keeps native tokens out of UI status", async () => {
  const root = await mkdtemp(join(tmpdir(), "responder-login-test-"));
  try {
    await mkdir(join(root, "node_modules/.bin"), { recursive: true });
    await mkdir(join(root, "auth"));
    const fakeServer = `#!/usr/bin/env node
const fs = require("node:fs");
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", line => {
 const message = JSON.parse(line);
 fs.appendFileSync(${JSON.stringify(join(root, "requests"))}, line + "\\n");
 if (message.method === "initialize") process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
 if (message.method === "account/login/start") {
   if (message.params.type !== "chatgptDeviceCode") process.exit(1);
   process.stdout.write(JSON.stringify({ id: message.id, result: { loginId: "login", userCode: "ABCD", verificationUrl: "https://auth.openai.com/codex/device" } }) + "\\n");
   fs.writeFileSync(process.env.CODEX_HOME + "/auth.json", JSON.stringify({ tokens: { access_token: "test-access-secret", refresh_token: "test-refresh-secret", id_token: "test-id", account_id: "account" } }));
   setTimeout(() => process.stdout.write(JSON.stringify({ method: "account/login/completed", params: { loginId: "login", success: true } }) + "\\n"), 20);
 }
});
`;
    expect(subscriptionLoginRunner).toContain("/home/daytona/.responder-subscription-login");
    await writeFile(join(root, "node_modules/.bin/codex"), fakeServer, { mode: 0o700 });
    await writeFile(join(root, "login.mjs"), subscriptionLoginRunner.replaceAll("/home/daytona/.responder-subscription-login", root));
    const process = spawn("node", [join(root, "login.mjs")], { stdio: "ignore" });
    await new Promise<void>((resolve, reject) => { process.on("error", reject); process.on("exit", code => code === 0 ? resolve() : reject(new Error("Managed login runner failed"))); });
    const status = await readFile(join(root, "status.json"), "utf8");
    expect(JSON.parse(status)).toEqual({ status: "connected" });
    expect(status).not.toContain("secret");
    const requests = (await readFile(join(root, "requests"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(requests.map(item => item.method)).toEqual(["initialize", "initialized", "account/login/start"]);
    expect(await readFile(join(root, "auth/auth.json"), "utf8")).toContain("test-refresh-secret");
  } finally { await rm(root, { recursive: true, force: true }); }
});
