import { expect, test } from "vitest";
import { fingerprint, fingerprintLog, messageBucketFor, stripNullBytes } from "./fingerprint.js";

test("fingerprint groups equivalent Next.js stacks whose generated chunk hashes differ", () => {
  const stackFor = (chunkHash: string) =>
    [
      "api_response_error: Too Many Requests",
      "    at a7.request (/var/task/apps/web/.next/server/chunks/ssr/node_modules__pnpm_dab6c57e._.js:17:64695)",
      "    at process.processTicksAndRejections (node:internal/process/task_queues:104:5)",
      `    at async f (/var/task/apps/web/.next/server/chunks/ssr/[root-of-the-server]__${chunkHash}._.js:2:2000)`,
      `    at async h (/var/task/apps/web/.next/server/chunks/ssr/[root-of-the-server]__${chunkHash}._.js:2:3306)`,
      "    at async m (/var/task/apps/web/.next/server/chunks/ssr/_978abe5d._.js:2:8316)",
    ].join("\n");

  const first = fingerprint({
    type: "api_response_error",
    message: "Too Many Requests",
    stacktrace: stackFor("cb666142"),
  });
  const second = fingerprint({
    type: "api_response_error",
    message: "Too Many Requests",
    stacktrace: stackFor("9598d6e6"),
  });

  expect(first.hash).toBe(second.hash);
});

test("fingerprint groups equivalent Next.js static chunks whose content hashes differ", () => {
  const fingerprintFor = (chunkHash: string) =>
    fingerprint({
      type: "TypeError",
      message: "Failed to render account page",
      stacktrace: `    at renderAccount (/var/task/apps/web/.next/static/chunks/webpack-${chunkHash}.js:1:200)`,
    });

  expect(fingerprintFor("332dbc5711e5ed").hash).toBe(fingerprintFor("9f76a111d542c0").hash);
});

test("fingerprint groups equivalent browser Next.js chunk URLs across builds", () => {
  const fingerprintFor = (chunkHash: string) =>
    fingerprint({
      type: "TypeError",
      message: "Failed to render account page",
      stacktrace: `    at renderAccount (https://example.com/_next/static/chunks/app/page-${chunkHash}.js:1:200)`,
    });

  expect(fingerprintFor("332dbc5711e5ed").hash).toBe(fingerprintFor("9f76a111d542c0").hash);
});

test("fingerprint ignores cache-busting suffixes on browser Next.js chunk URLs", () => {
  const fingerprintFor = (suffix: string) =>
    fingerprint({
      type: "TypeError",
      message: "Failed to render account page",
      stacktrace: `    at renderAccount (https://example.com/_next/static/chunks/app/page-332dbc5711e5ed.js${suffix}:1:200)`,
    });

  expect(fingerprintFor("?dpl=first").hash).toBe(fingerprintFor("#dpl=second").hash);
});

test("fingerprint ignores cache-busting suffixes on hashless Next.js chunk URLs", () => {
  const fingerprintFor = (suffix: string) =>
    fingerprint({
      type: "TypeError",
      message: "Failed to render account page",
      stacktrace: `    at renderAccount (https://example.com/_next/static/chunks/main-app.js${suffix}:1:200)`,
    });

  expect(fingerprintFor("?dpl=first").hash).toBe(fingerprintFor("#dpl=second").hash);
});

function iosHermesStack(input: { applicationId: string; bundleName: string }): string {
  const bundlePath =
    `/var/mobile/Containers/Data/Application/${input.applicationId}` +
    `/Library/Application Support/.expo-internal/${input.bundleName}`;
  return [
    "Error: fetch failed: The network connection was lost.",
    `    at recordSpanError (address at ${bundlePath}:1:100)`,
    `    at ?anon_0_ (address at ${bundlePath}:1:200)`,
    "    at anonymous (address at InternalBytecode.js:1:300)",
  ].join("\n");
}

// A single route-scanner error class (e.g. Phoenix NoRouteError) emits one
// exception per probed path. The stacktrace is identical across all of them —
// only the request path in the message differs — so without path normalization
// every probed URL becomes its own issue. One bot sweep then explodes into tens
// of thousands of distinct fingerprints, which floods issue ingestion. Collapse
// request paths so the whole sweep groups into a single issue.
test("messageBucketFor collapses request paths so route-scanner errors group", () => {
  const a = messageBucketFor("no route found for GET /wp-admin/install.php (AppWeb.Router)");
  const b = messageBucketFor("no route found for GET /.git/config (AppWeb.Router)");
  const c = messageBucketFor("no route found for GET /apple-touch-icon.png (AppWeb.Router)");
  expect(a).toBe(b);
  expect(b).toBe(c);
  expect(a).toMatch(/<path>/);
});

test("fingerprint groups same-stack route-scanner errors that differ only by path", () => {
  const stack = "    at AppWeb.Router.call (lib/app_web/router.ex:1:1)";
  const fp1 = fingerprint({
    type: "Elixir.Phoenix.Router.NoRouteError",
    stacktrace: stack,
    message: "no route found for GET /wp-admin/install.php (AppWeb.Router)",
  });
  const fp2 = fingerprint({
    type: "Elixir.Phoenix.Router.NoRouteError",
    stacktrace: stack,
    message: "no route found for GET /.env (AppWeb.Router)",
  });
  expect(fp1.hash).toBe(fp2.hash);
});

test("fingerprint groups equivalent iOS Hermes stacks across app-container IDs", () => {
  const first = fingerprint({
    type: "Error",
    stacktrace: iosHermesStack({
      applicationId: "11111111-1111-4111-8111-111111111111",
      bundleName: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bundle",
    }),
    message: "Could not PATCH data: The network connection was lost.",
  });
  const second = fingerprint({
    type: "Error",
    stacktrace: iosHermesStack({
      applicationId: "22222222-2222-4222-8222-222222222222",
      bundleName: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bundle",
    }),
    message: "Could not PATCH data: The network connection was lost.",
  });

  expect(first.hash).toBe(second.hash);
});

test("fingerprint groups equivalent iOS Hermes stacks across Expo bundle IDs", () => {
  const first = fingerprint({
    type: "Error",
    stacktrace: iosHermesStack({
      applicationId: "11111111-1111-4111-8111-111111111111",
      bundleName: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bundle",
    }),
    message: "Could not PATCH data: The network connection was lost.",
  });
  const second = fingerprint({
    type: "Error",
    stacktrace: iosHermesStack({
      applicationId: "11111111-1111-4111-8111-111111111111",
      bundleName: "bundle-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jsbundle",
    }),
    message: "Could not PATCH data: The network connection was lost.",
  });

  expect(first.hash).toBe(second.hash);
});

test("messageBucketFor keeps a bare path token distinct from a real path", () => {
  // A leading-slash path collapses; an in-word slash (and/or) must not.
  expect(messageBucketFor("request to /api/v2/users failed")).toBe("request to <path> failed");
  expect(messageBucketFor("read timeout and/or connection reset")).toBe("read timeout and/or connection reset");
});

test("messageBucketFor still separates genuinely different messages", () => {
  expect(messageBucketFor("model is not supported")).not.toBe(messageBucketFor("extra inputs are not permitted"));
});

const VERCEL_LOG = {
  service: "storefront",
  severity: "ERROR",
  exceptionType: "ERROR",
  stacktrace: null,
};

function vercelRuntimeEnvelope(input: {
  id: string;
  method?: string;
  path?: string;
  status?: number;
  report?: string;
  startMetadata?: string;
}): string {
  const method = input.method ?? "GET";
  const path = input.path ?? "/collections/summer";
  const status = input.status ?? 503;
  const report =
    input.report ??
    "Duration: 25880 ms Billed Duration: 25880 ms Memory Size: 2048 MB Max Memory Used: 673 MB";
  const startMetadata = input.startMetadata ? ` ${input.startMetadata}` : "";
  return [
    `START RequestId: ${input.id}${startMetadata}`,
    `[${method}] ${path} status=${status}`,
    `END RequestId: ${input.id}`,
    `REPORT RequestId: ${input.id} ${report}`,
  ].join("\n");
}

test("fingerprintLog groups equivalent Vercel runtime request envelopes", () => {
  const first = fingerprintLog({
    ...VERCEL_LOG,
    body: vercelRuntimeEnvelope({
      id: "sin1::wgjjq-1783721543178-bb29a25d147a",
      path: "/collections/summer?direction=next&filter.p.product_type=Topical",
    }),
  });
  const second = fingerprintLog({
    ...VERCEL_LOG,
    body: vercelRuntimeEnvelope({
      id: "gru1::sv2np-1783721551971-8ab18e6846a0",
      path: "/collections/kids?filter.p.product_type=Shampoo",
      report:
        "Duration: 26703 ms Billed Duration: 26703 ms Memory Size: 2048 MB Max Memory Used: 701 MB",
    }),
  });

  expect(first.hash).toBe(second.hash);
});

test("fingerprintLog separates Vercel runtime request envelopes by status", () => {
  const unavailable = fingerprintLog({
    ...VERCEL_LOG,
    body: vercelRuntimeEnvelope({
      id: "sin1::wgjjq-1783721543178-bb29a25d147a",
      status: 503,
    }),
  });
  const internalError = fingerprintLog({
    ...VERCEL_LOG,
    body: vercelRuntimeEnvelope({
      id: "gru1::sv2np-1783721551971-8ab18e6846a0",
      status: 500,
    }),
  });

  expect(unavailable.hash).not.toBe(internalError.hash);
});

test("fingerprintLog accepts scoped and opaque Vercel request IDs", () => {
  const scoped = fingerprintLog({
    ...VERCEL_LOG,
    body: vercelRuntimeEnvelope({ id: "sin1::wgjjq-1783721543178-bb29a25d147a" }),
  });
  const opaque = fingerprintLog({
    ...VERCEL_LOG,
    body: vercelRuntimeEnvelope({ id: "3f0f7fc2-c088-4e5f-a829-14d3fd5bf8a1" }).replaceAll(
      "\n",
      "\r\n",
    ),
  });

  expect(scoped.hash).toBe(opaque.hash);
});

test("fingerprintLog ignores Vercel START-line runtime version metadata", () => {
  const latest = fingerprintLog({
    ...VERCEL_LOG,
    body: vercelRuntimeEnvelope({
      id: "sin1::request-a",
      startMetadata: "Version: $LATEST",
    }),
  });
  const numbered = fingerprintLog({
    ...VERCEL_LOG,
    body: vercelRuntimeEnvelope({
      id: "gru1::request-b",
      startMetadata: "Version: 42",
    }),
  });

  expect(latest.hash).toBe(numbered.hash);
});

test("fingerprintLog separates Vercel runtime request envelopes by method", () => {
  const get = fingerprintLog({
    ...VERCEL_LOG,
    body: vercelRuntimeEnvelope({ id: "sin1::request-a", method: "GET" }),
  });
  const post = fingerprintLog({
    ...VERCEL_LOG,
    body: vercelRuntimeEnvelope({ id: "sin1::request-b", method: "POST" }),
  });

  expect(get.hash).not.toBe(post.hash);
});

test("fingerprintLog preserves application output inside a runtime invocation", () => {
  const requestId = "sin1::request-a";
  const withApplicationOutput = (output: string) =>
    [
      `START RequestId: ${requestId}`,
      "[GET] /collections/summer status=503",
      output,
      `END RequestId: ${requestId}`,
      `REPORT RequestId: ${requestId} Duration: 25880 ms`,
    ].join("\n");
  const timeout = fingerprintLog({
    ...VERCEL_LOG,
    body: withApplicationOutput("database connection timed out"),
  });
  const invalidResponse = fingerprintLog({
    ...VERCEL_LOG,
    body: withApplicationOutput("upstream returned invalid JSON"),
  });

  expect(timeout.hash).not.toBe(invalidResponse.hash);
});

test("fingerprintLog groups SQLAlchemy integrity errors with different row values", () => {
  const tracebackBodyFor = (input: { productName: string; productId: string }) =>
    [
      "Traceback (most recent call last):",
      '  File "/srv/app/importer.py", line 42, in import_product',
      "    session.flush()",
      'sqlalchemy.exc.IntegrityError: (psycopg2.errors.NotNullViolation) null value in column "vendor_product_id" of relation "product_variants" violates not-null constraint',
      `DETAIL:  Failing row contains (${input.productId}, ${input.productName}, null).`,
      "[SQL: INSERT INTO product_variants (id, name, vendor_product_id) VALUES (%(id)s, %(name)s, %(vendor_product_id)s)]",
      `[parameters: {'id': '${input.productId}', 'name': '${input.productName}', 'vendor_product_id': None}]`,
      "(Background on this error at: https://sqlalche.me/e/20/gkpj)",
    ].join("\n");
  const handledBodyFor = (input: { orderNumber: string; productName: string }) =>
    [
      `Failed to store order ${input.orderNumber}: (psycopg2.errors.NotNullViolation) null value in column "vendor_product_id" of relation "product_variants" violates not-null constraint`,
      `DETAIL:  Failing row contains (product-c, ${input.productName}, null).`,
      "[SQL: INSERT INTO product_variants (id, name, vendor_product_id) VALUES (%(id)s, %(name)s, %(vendor_product_id)s)]",
      `[parameters: {'id': 'product-c', 'name': '${input.productName}', 'vendor_product_id': None}]`,
      "(Background on this error at: https://sqlalche.me/e/20/gkpj)",
    ].join("\n");

  const first = fingerprintLog({
    service: "catalog-worker",
    severity: "ERROR",
    body: tracebackBodyFor({ productName: "Blue Fluoride Varnish", productId: "product-a" }),
    exceptionType: "IntegrityError",
    stacktrace: null,
  });
  const second = fingerprintLog({
    service: "catalog-worker",
    severity: "ERROR",
    body: handledBodyFor({ orderNumber: "order-200", productName: "Mint Prophy Paste" }),
    exceptionType: "IntegrityError",
    stacktrace: null,
  });

  expect(first.hash).toBe(second.hash);
});

test("fingerprintLog keeps different Postgres constraints separate", () => {
  const fingerprintFor = (column: string) =>
    fingerprintLog({
      service: "catalog-worker",
      severity: "ERROR",
      body: `psycopg2.errors.NotNullViolation: null value in column "${column}" of relation "product_variants" violates not-null constraint`,
      exceptionType: "IntegrityError",
      stacktrace: null,
    });

  expect(fingerprintFor("vendor_product_id").hash).not.toBe(fingerprintFor("vendor_item_id").hash);
});

test("fingerprintLog redacts volatile quoted values in Postgres headlines", () => {
  const fingerprintFor = (value: string) =>
    fingerprintLog({
      service: "catalog-worker",
      severity: "ERROR",
      body: `psycopg2.errors.InvalidTextRepresentation: invalid input syntax for type integer: "${value}"`,
      exceptionType: "DataError",
      stacktrace: null,
    });

  expect(fingerprintFor("not-a-number").hash).toBe(fingerprintFor("still-not-a-number").hash);
});

test("fingerprintLog groups equivalent psycopg2 and psycopg3 errors", () => {
  const fingerprintFor = (driver: "psycopg2" | "psycopg") =>
    fingerprintLog({
      service: "catalog-worker",
      severity: "ERROR",
      body: `(${driver}.errors.NotNullViolation) null value in column "vendor_product_id" of relation "product_variants" violates not-null constraint`,
      exceptionType: "IntegrityError",
      stacktrace: null,
    });

  expect(fingerprintFor("psycopg2").hash).toBe(fingerprintFor("psycopg").hash);
});

test("fingerprintLog ignores flattened SQLAlchemy metadata after a psycopg headline", () => {
  const fingerprintFor = (orderId: string) =>
    fingerprintLog({
      service: "catalog-worker",
      severity: "ERROR",
      body: `(psycopg2.errors.NotNullViolation) null value in column "vendor_product_id" of relation "product_variants" violates not-null constraint DETAIL: Failing row contains (${orderId}, null). [SQL: INSERT INTO product_variants ...] [parameters: {'id': '${orderId}'}]`,
      exceptionType: "IntegrityError",
      stacktrace: null,
    });

  expect(fingerprintFor("order-a").hash).toBe(fingerprintFor("order-b").hash);
});

test("fingerprintLog ignores flattened Postgres diagnostic fields", () => {
  const fingerprintFor = (diagnostic: string) =>
    fingerprintLog({
      service: "catalog-worker",
      severity: "ERROR",
      body: `(psycopg.errors.NotNullViolation) null value in column "vendor_product_id" of relation "product_variants" violates not-null constraint ${diagnostic}`,
      exceptionType: "IntegrityError",
      stacktrace: null,
    });

  expect(fingerprintFor("LINE 1: INSERT INTO product_variants VALUES ('order-a')").hash).toBe(fingerprintFor("HINT: Retry without value 'order-b'").hash);
});

// Postgres text and jsonb columns reject the NUL byte (0x00) — it raises
// `22021 invalid byte sequence for encoding "UTF8": 0x00`. Telemetry can carry
// a raw NUL in a message or stack frame; the fingerprint outputs feed straight
// into the issues upsert, so they must be NUL-free.
const NUL = String.fromCharCode(0);

test("stripNullBytes removes NUL bytes and leaves other text intact", () => {
  expect(stripNullBytes(`ab${NUL}cd`)).toBe("abcd");
  expect(stripNullBytes(`${NUL}boom${NUL}`)).toBe("boom");
  expect(stripNullBytes("clean string")).toBe("clean string");
  expect(stripNullBytes(null)).toBe(null);
  expect(stripNullBytes(undefined)).toBe(undefined);
});

test("fingerprint strips NUL bytes from exception type and frames", () => {
  const fp = fingerprint({
    type: `Boom${NUL}Error`,
    stacktrace: `    at do${NUL}Thing (apps/worker/src/x.ts:1:1)`,
    message: "broke here",
  });
  expect(fp.exceptionType.includes(NUL)).toBe(false);
  expect(!fp.topFrame?.includes(NUL)).toBeTruthy();
  for (const frame of fp.normalizedFrames) {
    expect(frame.includes(NUL)).toBe(false);
  }
});

test("fingerprintLog strips NUL bytes from exception type", () => {
  const fp = fingerprintLog({
    service: "superlog-worker",
    severity: "ERROR",
    body: `tick step failed${NUL}`,
    exceptionType: `Cause${NUL}Error`,
    stacktrace: null,
  });
  expect(fp.exceptionType.includes(NUL)).toBe(false);
});

test("fingerprints carry the algorithm version", () => {
  expect(fingerprint({ type: "Error", stacktrace: null, message: "boom" }).hash).toMatch(/^v1:[0-9a-f]{16}$/);
  expect(fingerprintLog({ service: "api", severity: "ERROR", body: "boom" }).hash).toMatch(/^v1:[0-9a-f]{16}$/);
});

function pythonTraceback(input: { line: number; libraryVersion: string }): string {
  return [
    "Traceback (most recent call last):",
    `  File "/usr/local/lib/python${input.libraryVersion}/site-packages/flask/app.py", line 880, in full_dispatch_request`,
    "    rv = self.dispatch_request()",
    `  File "/srv/app/billing/invoices.py", line ${input.line}, in create_invoice`,
    "    total = compute_total(order)",
    `  File "/srv/app/billing/totals.py", line ${input.line + 10}, in compute_total`,
    "    return sum(item.price for item in order.items)",
    "TypeError: unsupported operand type(s) for +: 'int' and 'NoneType'",
  ].join("\n");
}

test("fingerprint reads Python tracebacks innermost frame first and skips library frames", () => {
  const fp = fingerprint({
    type: "TypeError",
    message: "unsupported operand type(s) for +: 'int' and 'NoneType'",
    stacktrace: pythonTraceback({ line: 12, libraryVersion: "3.12" }),
  });

  expect(fp.normalizedFrames).toEqual(["compute_total@app/billing/totals.py", "create_invoice@app/billing/invoices.py"]);
  expect(fp.topFrame).toBe("compute_total@app/billing/totals.py");
});

test("fingerprint groups Python tracebacks across line shifts and runtime upgrades", () => {
  const fingerprintFor = (line: number, libraryVersion: string) =>
    fingerprint({
      type: "TypeError",
      message: "unsupported operand type(s) for +: 'int' and 'NoneType'",
      stacktrace: pythonTraceback({ line, libraryVersion }),
    }).hash;

  expect(fingerprintFor(12, "3.12")).toBe(fingerprintFor(40, "3.13"));
});

test("fingerprint separates Python errors raised in different functions", () => {
  const fingerprintFor = (fn: string) =>
    fingerprint({
      type: "KeyError",
      message: "'customer'",
      stacktrace: `Traceback (most recent call last):\n  File "/srv/app/api.py", line 3, in ${fn}\nKeyError: 'customer'`,
    }).hash;

  expect(fingerprintFor("create_order")).not.toBe(fingerprintFor("refund_order"));
});

test("fingerprintLog groups Python tracebacks logged as the body by their frames", () => {
  const fingerprintFor = (line: number, orderId: string) =>
    fingerprintLog({
      service: "billing",
      severity: "ERROR",
      body: [
        "Traceback (most recent call last):",
        `  File "/srv/app/billing/totals.py", line ${line}, in compute_total`,
        "    return sum(item.price for item in order.items)",
        `KeyError: '${orderId}'`,
      ].join("\n"),
    });

  const first = fingerprintFor(7, "order-1");
  expect(first.hash).toBe(fingerprintFor(30, "order-2").hash);
  expect(first).toMatchObject({ exceptionType: "KeyError", topFrame: "compute_total@app/billing/totals.py" });
});
