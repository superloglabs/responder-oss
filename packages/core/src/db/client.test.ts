import { describe, expect, it } from "vitest";
import { databaseConnectionString } from "./client.js";

describe("database connection configuration", () => {
  it("uses DATABASE_URL when it is present", () => {
    expect(
      databaseConnectionString({ DATABASE_URL: "postgresql://direct" }),
    ).toBe("postgresql://direct");
  });

  it("builds an encoded RDS connection string from separate secret fields", () => {
    expect(
      databaseConnectionString({
        DATABASE_HOST: "database.internal",
        DATABASE_NAME: "responder",
        DATABASE_PASSWORD: "secret:/?#[]@!",
        DATABASE_PORT: "5432",
        DATABASE_SSL_MODE: "require",
        DATABASE_SSL_ROOT_CERT: "/app/certs/global bundle.pem",
        DATABASE_USER: "responder app",
      }),
    ).toBe(
      "postgresql://responder%20app:secret%3A%2F%3F%23%5B%5D%40!" +
        "@database.internal:5432/responder?sslmode=require&" +
        "sslrootcert=%2Fapp%2Fcerts%2Fglobal+bundle.pem",
    );
  });

  it("returns null when the split configuration is incomplete", () => {
    expect(databaseConnectionString({ DATABASE_HOST: "database.internal" })).toBeNull();
  });
});
