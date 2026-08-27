import { expect, test, type Page } from "@playwright/test";

const organization = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Acme",
  slug: "acme-workspace-id",
  createdAt: new Date().toISOString(),
  logo: null,
  metadata: null,
};

const user = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Ada Lovelace",
  email: "ada@example.com",
  emailVerified: true,
  image: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function sessionResponse(activeOrganizationId: string | null) {
  return {
    session: {
      id: "session-id",
      userId: user.id,
      activeOrganizationId,
      token: "session-token",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    user,
  };
}

async function mockApplicationApis(page: Page) {
  await page.route("**/api/agents", (route) =>
    route.fulfill({ json: { agents: [] } }),
  );
  await page.route(/\/api\/agents\/options(?:\/refresh\/slack)?$/, (route) =>
    route.fulfill({
      json: { accounts: [], resources: [], repositories: [], secrets: [] },
    }),
  );
  await page.route("**/api/integrations", (route) =>
    route.fulfill({ json: { integrations: [] } }),
  );
  await page.route("**/api/billing", (route) =>
    route.fulfill({
      json: {
        configured: false,
        enabled: false,
        payAsYouGo: false,
        remaining: 0,
      },
    }),
  );
}

test.beforeEach(async ({ page }) => {
  await mockApplicationApis(page);
});

async function mockSignedInWorkspace(page: Page) {
  await page.route("**/api/auth/**", async (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path.endsWith("/get-session")) {
      await route.fulfill({ json: sessionResponse(organization.id) });
      return;
    }

    if (path.endsWith("/organization/list")) {
      await route.fulfill({ json: [organization] });
      return;
    }

    if (path.endsWith("/organization/get-full-organization")) {
      await route.fulfill({ json: organization });
      return;
    }

    await route.fulfill({ json: null });
  });
}

test("opens agent creation after creating a workspace", async ({ page }) => {
  let activeOrganizationId: string | null = null;

  await page.route("**/api/auth/**", async (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path.endsWith("/get-session")) {
      await route.fulfill({ json: sessionResponse(activeOrganizationId) });
      return;
    }

    if (path.endsWith("/organization/list")) {
      await route.fulfill({ json: activeOrganizationId ? [organization] : [] });
      return;
    }

    if (path.endsWith("/organization/create")) {
      await route.fulfill({ json: organization });
      return;
    }

    if (path.endsWith("/organization/set-active")) {
      activeOrganizationId = organization.id;
      await route.fulfill({ json: null });
      return;
    }

    if (path.endsWith("/organization/get-full-organization")) {
      await route.fulfill({ json: organization });
      return;
    }

    await route.fulfill({ json: null });
  });
  await page.goto("/agents");
  await expect(page.getByRole("heading", { name: "Create a workspace" })).toBeVisible();

  await page.getByLabel("New workspace").fill("Acme");
  await page.getByRole("button", { name: "Create workspace" }).click();

  await expect(page).toHaveURL(/\/agents\/new$/);
  await expect(page.getByRole("heading", { name: "Create agent" })).toBeVisible();
});

test("shows specific workspace secret validation issues", async ({
  page,
}) => {
  await page.route("**/api/auth/**", async (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path.endsWith("/get-session")) {
      await route.fulfill({ json: sessionResponse(organization.id) });
      return;
    }

    if (path.endsWith("/organization/list")) {
      await route.fulfill({ json: [organization] });
      return;
    }

    if (path.endsWith("/organization/get-full-organization")) {
      await route.fulfill({ json: organization });
      return;
    }

    await route.fulfill({ json: null });
  });
  const agentOptions = {
    accounts: [
      {
        id: "slack-account-1",
        provider: "slack",
        displayName: "Acme Slack",
        slackContextAvailable: true,
      },
    ],
    resources: [
      {
        id: "slack-channel-1",
        integrationAccountId: "slack-account-1",
        kind: "slack_channel",
        externalId: "C123",
        displayName: "incidents",
      },
    ],
    repositories: [],
    secrets: [],
  };
  await page.route(/\/api\/agents\/options(?:\/refresh\/slack)?$/, (route) =>
    route.fulfill({ json: agentOptions }),
  );
  await page.route("**/api/agents/secrets", async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      name: "PATH",
      value: "write-only-value",
      allowedHosts: ["https://api.example.com/path"],
    });
    await route.fulfill({
      status: 400,
      json: {
        error: "Invalid workspace secret",
        issues: [
          {
            code: "custom",
            path: ["name"],
            message:
              "PATH controls the sandbox runtime; choose a credential-specific environment variable name",
          },
          {
            code: "invalid_format",
            path: ["allowedHosts", 0],
            message: "Use a hostname without a scheme, path, or port",
          },
        ],
      },
    });
  });

  await page.goto("/agents/new");
  await page.getByText("Alert in a Slack channel", { exact: true }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.getByRole("heading", { name: "Agent context" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add secret" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Add a workspace secret",
  });
  await dialog.getByLabel("Environment variable").fill("PATH");
  await dialog.getByLabel("Secret value").fill("write-only-value");
  await dialog
    .getByLabel("Allowed hosts")
    .fill("https://api.example.com/path");
  await dialog.getByRole("button", { name: "Store and add" }).click();

  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveText(
    "PATH controls the sandbox runtime; choose a credential-specific environment variable name. Use a hostname without a scheme, path, or port",
  );
});

test("explains an earlier missing requirement when a saved draft resumes on the prompt step", async ({
  page,
}) => {
  await mockSignedInWorkspace(page);
  await page.addInitScript(() => {
    window.sessionStorage.setItem("responder:new-agent-step", "4");
  });

  await page.goto("/agents/new");
  await expect(page.getByRole("heading", { name: "Prompt" })).toBeVisible();
  await expect(
    page.getByText("Connect Sentry and choose at least one project."),
  ).toBeVisible();

  await page.getByRole("button", { name: "Create agent" }).click();

  await expect(page.getByRole("alert")).toHaveText(
    "Connect Sentry and choose at least one project.",
  );
  await expect(page.getByRole("heading", { name: "Input" })).toBeVisible();
});

test("submits a complete saved draft without depending on a native submitter", async ({
  page,
}) => {
  await mockSignedInWorkspace(page);
  const agentOptions = {
    accounts: [
      {
        id: "slack-account-1",
        provider: "slack",
        displayName: "Acme Slack",
        slackContextAvailable: true,
      },
    ],
    resources: [
      {
        id: "slack-channel-1",
        integrationAccountId: "slack-account-1",
        kind: "slack_channel",
        externalId: "C123",
        displayName: "incidents",
      },
    ],
    repositories: [],
    secrets: [],
  };
  await page.route(/\/api\/agents\/options(?:\/refresh\/slack)?$/, (route) =>
    route.fulfill({ json: agentOptions }),
  );
  await page.route("**/api/agents", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({ status: 201, json: { agentId: "agent-1" } });
      return;
    }
    await route.fulfill({ json: { agents: [] } });
  });
  await page.addInitScript(() => {
    window.sessionStorage.setItem("responder:new-agent-step", "4");
    window.sessionStorage.setItem(
      "responder:new-agent-draft",
      JSON.stringify({
        inputKind: "slack_channel",
        slackInputResourceId: "slack-channel-1",
        outputMode: "thread",
      }),
    );
  });

  await page.goto("/agents/new");
  await expect(page.getByRole("heading", { name: "Prompt" })).toBeVisible();
  const createRequest = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === "/api/agents" &&
      request.method() === "POST",
  );

  await page.locator("form.createAgentForm").evaluate((form) =>
    (form as HTMLFormElement).requestSubmit(),
  );

  await createRequest;
  await expect(page).toHaveURL(/\/agents\/agent-1$/);
});

test("keeps an invitation link open while the recipient signs in", async ({
  page,
}) => {
  let signedIn = false;

  await page.route("**/api/auth/**", async (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path.endsWith("/get-session")) {
      await route.fulfill({
        json: signedIn ? sessionResponse(null) : null,
      });
      return;
    }

    if (path.endsWith("/sign-in/email")) {
      signedIn = true;
      await route.fulfill({
        json: { redirect: false, token: "session-token", user },
      });
      return;
    }

    await route.fulfill({ json: null });
  });

  const invitationId = "33333333-3333-4333-8333-333333333333";
  await page.goto(`/invite/${invitationId}`);

  await expect(page).toHaveURL(new RegExp(`/invite/${invitationId}$`));
  await expect(page.getByText("Workspace invitation")).toBeVisible();
  await expect(page.getByRole("heading", { name: "You're invited" })).toBeVisible();
  await expect(
    page.getByText(
      "Sign in or create an account with the invited email to join this workspace.",
    ),
  ).toBeVisible();

  await page.getByRole("button", { name: "New to Responder? Create an account" }).click();
  await expect(
    page.getByRole("heading", { name: "Create your account to join" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Already have an account? Sign in" }).click();

  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill("correct-horse-battery-staple");
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page).toHaveURL(new RegExp(`/invite/${invitationId}$`));
  await expect(
    page.getByRole("heading", { name: "Join this workspace" }),
  ).toBeVisible();
});

test("accepts an invitation and opens its workspace", async ({ page }) => {
  const invitationId = "33333333-3333-4333-8333-333333333333";
  let activeOrganizationId: string | null = null;
  let acceptedInvitationId: string | null = null;

  await page.route("**/api/auth/**", async (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path.endsWith("/get-session")) {
      await route.fulfill({ json: sessionResponse(activeOrganizationId) });
      return;
    }

    if (path.endsWith("/organization/accept-invitation")) {
      const request = route.request().postDataJSON() as { invitationId: string };
      acceptedInvitationId = request.invitationId;
      await route.fulfill({
        json: {
          invitation: {
            id: invitationId,
            organizationId: organization.id,
            email: user.email,
            role: "member",
            status: "accepted",
          },
          member: {
            id: "44444444-4444-4444-8444-444444444444",
            organizationId: organization.id,
            userId: user.id,
            role: "member",
          },
        },
      });
      return;
    }

    if (path.endsWith("/organization/set-active")) {
      activeOrganizationId = organization.id;
      await route.fulfill({ json: null });
      return;
    }

    if (path.endsWith("/organization/get-full-organization")) {
      await route.fulfill({ json: organization });
      return;
    }

    await route.fulfill({ json: null });
  });
  await page.goto(`/invite/${invitationId}`);
  await expect(
    page.getByRole("heading", { name: "Join this workspace" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Accept invitation" }).click();

  await expect(page).toHaveURL(/\/agents$/);
  expect(acceptedInvitationId).toBe(invitationId);
  expect(activeOrganizationId).toBe(organization.id);
});

test("redirects malformed invitation links", async ({ page }) => {
  await page.route("**/api/auth/**", async (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path.endsWith("/get-session")) {
      await route.fulfill({ json: sessionResponse(organization.id) });
      return;
    }

    await route.fulfill({ json: null });
  });

  await page.goto("/invite/xyz");

  await expect(page).toHaveURL(/\/agents$/);
  await expect(
    page.getByRole("heading", { name: "Agents", exact: true }),
  ).toBeVisible();
});
