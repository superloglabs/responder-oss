import { type FormEvent, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { authErrorCode } from "../auth-error-code";
import { authClient } from "../auth-client";
import { AppShell } from "../components/app-shell";
import { Avatar, Badge, Button, DataTable } from "../design-system";
import { useDocumentTitle } from "../use-document-title";
import {
  canImpersonateUser,
  isSuperuserRole,
  type SuperuserListUser,
} from "./superuser-users-presentation";

export function SuperuserUsersPage() {
  useDocumentTitle("User support");
  const session = authClient.useSession();
  const [users, setUsers] = useState<SuperuserListUser[]>([]);
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [impersonatingId, setImpersonatingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isSuperuser = isSuperuserRole(session.data?.user.role);
  const actorUserId = session.data?.user.id ?? null;

  useEffect(() => {
    if (!isSuperuser) return;
    let active = true;
    const search = new URLSearchParams();
    if (submittedQuery) search.set("search", submittedQuery);
    const suffix = search.size > 0 ? `?${search.toString()}` : "";
    void fetch(`/api/superuser/users${suffix}`)
      .then(async (response) => {
        if (!active) return;
        if (!response.ok) {
          console.error(
            JSON.stringify({
              event: "superuser_list_users_failed",
              actorUserId,
              errorCode: String(response.status),
            }),
          );
          setError("Could not load users.");
          return;
        }
        const result = (await response.json()) as {
          users: SuperuserListUser[];
        };
        if (active) setUsers(result.users);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        console.error(
          JSON.stringify({
            event: "superuser_list_users_failed",
            actorUserId,
            errorCode: cause instanceof Error ? cause.name : "unknown",
          }),
        );
        setError("Could not load users.");
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [actorUserId, isSuperuser, submittedQuery]);

  if (!isSuperuser) {
    return <Navigate replace to="/agents" />;
  }

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextQuery = query.trim();
    if (nextQuery === submittedQuery) return;
    setError(null);
    setIsLoading(true);
    setSubmittedQuery(nextQuery);
  }

  async function impersonate(user: SuperuserListUser) {
    if (!canImpersonateUser(user)) return;
    const confirmed = window.confirm(
      `View Responder as ${user.name || user.email}? Actions you take will use their access.`,
    );
    if (!confirmed) return;

    setError(null);
    setImpersonatingId(user.id);
    const result = await authClient.admin.impersonateUser({ userId: user.id });
    setImpersonatingId(null);
    if (result.error) {
      console.error(
        JSON.stringify({
          event: "impersonation_start_failed",
          errorCode: authErrorCode(result.error),
          actorUserId,
          targetUserId: user.id,
        }),
      );
      setError(result.error.message ?? "Could not view Responder as this user.");
      return;
    }
    window.location.assign("/agents");
  }

  return (
    <AppShell active="settings" density="settings">
      <section className="settingsHeading superuserHeading">
        <div>
          <Badge tone="warning">Superuser</Badge>
          <h1>User support</h1>
          <p>Open Responder with a user’s access to reproduce what they see.</p>
        </div>
        <form className="superuserSearch" onSubmit={search}>
          <label className="srOnly" htmlFor="superuser-user-search">
            Search users by email
          </label>
          <input
            id="superuser-user-search"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by email"
            type="search"
            value={query}
          />
          <Button type="submit">Search</Button>
        </form>
      </section>

      {error ? (
        <p className="settingsNotice settingsNotice--error" role="alert">
          {error}
        </p>
      ) : null}

      <section className="superuserUsers" aria-busy={isLoading}>
        <DataTable
          aria-label="Responder users"
          columns={[
            {
              header: "User",
              key: "user",
              render: (user) => (
                <div className="superuserUser">
                  <Avatar
                    image={user.image ?? undefined}
                    name={user.name || user.email}
                    size="small"
                  />
                  <span>
                    <strong>{user.name || "Unnamed user"}</strong>
                    <small>{user.email}</small>
                  </span>
                </div>
              ),
            },
            {
              header: "Joined",
              key: "joined",
              render: (user) => new Date(user.createdAt).toLocaleDateString(),
              width: "160px",
            },
            {
              align: "right",
              header: "",
              key: "action",
              render: (user) =>
                isSuperuserRole(user.role) ? (
                  <Badge>Superuser</Badge>
                ) : user.banned ? (
                  <Badge tone="danger">Suspended</Badge>
                ) : !canImpersonateUser(user) ? (
                  <Badge>Protected</Badge>
                ) : (
                  <Button
                    disabled={impersonatingId !== null}
                    loading={impersonatingId === user.id}
                    onClick={() => void impersonate(user)}
                    size="small"
                  >
                    View as user
                  </Button>
                ),
              width: "180px",
            },
          ]}
          emptyMessage={isLoading ? "Loading users…" : "No users found"}
          getRowKey={(user) => user.id}
          rows={isLoading ? [] : users}
        />
      </section>
    </AppShell>
  );
}
