import { type FormEvent, useEffect, useRef, useState } from "react";
import { Navigate } from "react-router-dom";
import { authErrorCode } from "../auth-error-code";
import { authClient } from "../auth-client";
import { AppShell } from "../components/app-shell";
import { DataTableSkeleton } from "../components/screen-skeletons";
import { Avatar, Badge, Button, DataTable } from "../design-system";
import { useDocumentTitle } from "../use-document-title";
import {
  canImpersonateUser,
  isSuperuserRole,
  otherCellViewUrl,
  requestedViewUser,
  type SuperuserListCell,
  type SuperuserListUser,
  viewAsUserParameter,
} from "./superuser-users-presentation";

// A link from another cell's user support page names the user to view as.
function initialParameters() {
  const parameters = new URL(window.location.href).searchParams;
  return {
    search: parameters.get("search")?.trim() ?? "",
    viewId: parameters.get(viewAsUserParameter),
  };
}

export function SuperuserUsersPage() {
  useDocumentTitle("User support");
  const session = authClient.useSession();
  const [initial] = useState(initialParameters);
  const [users, setUsers] = useState<SuperuserListUser[]>([]);
  const [currentCell, setCurrentCell] = useState<string | null>(null);
  const [unavailableCells, setUnavailableCells] = useState<SuperuserListCell[]>([]);
  const [query, setQuery] = useState(initial.search);
  const [submittedQuery, setSubmittedQuery] = useState(initial.search);
  const [loaded, setLoaded] = useState(false);
  const handledViewId = useRef(false);
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
          currentCell: string | null;
          unavailableCells: SuperuserListCell[];
          users: SuperuserListUser[];
        };
        if (!active) return;
        setUsers(result.users);
        setCurrentCell(result.currentCell);
        setUnavailableCells(result.unavailableCells);
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
        if (!active) return;
        setIsLoading(false);
        setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [actorUserId, isSuperuser, submittedQuery]);

  // Asks once, after the first load, to view as the user a link named.
  useEffect(() => {
    if (!loaded || handledViewId.current || !initial.viewId) return;
    handledViewId.current = true;
    const url = new URL(window.location.href);
    url.searchParams.delete(viewAsUserParameter);
    window.history.replaceState(window.history.state, "", url);
    const user = requestedViewUser(users, initial.viewId, currentCell);
    if (user) void impersonate(user);
    // impersonate only reads state set before this load finished.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCell, initial.viewId, loaded, users]);

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
    // That cell asks to confirm, since only it can start the session.
    const otherCellUrl = otherCellViewUrl(user, currentCell);
    if (otherCellUrl) {
      window.location.assign(otherCellUrl);
      return;
    }
    const confirmed = window.confirm(
      `View Responder as ${user.name || user.email}${
        user.cell ? ` in ${user.cell.label}` : ""
      }? Actions you take will use their access.`,
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
    window.location.assign("/app");
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
      {unavailableCells.length > 0 ? (
        <p className="settingsNotice settingsNotice--error" role="alert">
          Could not load users from{" "}
          {unavailableCells.map((cell) => cell.label).join(", ")}.
        </p>
      ) : null}

      <section className="superuserUsers">
        {isLoading ? (
          <DataTableSkeleton
            className=""
            columns={[
              { cell: "avatar", header: "User", key: "user" },
              { header: "Region", key: "region", width: "120px" },
              { header: "Joined", key: "joined", width: "160px" },
              { cell: "empty", header: "", key: "action", width: "180px" },
            ]}
            label="Loading users…"
            variant={null}
          />
        ) : (
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
              ...(currentCell
                ? [
                    {
                      header: "Region",
                      key: "region",
                      render: (user: SuperuserListUser) => user.cell?.label ?? "",
                      width: "120px",
                    },
                  ]
                : []),
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
            emptyMessage="No users found"
            getRowKey={(user) => `${user.cell?.id ?? ""}:${user.id}`}
            rows={users}
          />
        )}
      </section>
    </AppShell>
  );
}
