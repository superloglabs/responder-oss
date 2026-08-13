interface ApplicationErrorProps {
  eventId?: string;
}

export function ApplicationError({ eventId }: ApplicationErrorProps) {
  return (
    <main className="authPage">
      <section className="authCard">
        <div className="authIntro">
          <h1>Something went wrong</h1>
          <p>
            Responder could not finish loading this page. Reload it to return to
            the dashboard.
          </p>
        </div>
        {eventId ? (
          <p className="authMuted">Error reference: {eventId}</p>
        ) : null}
        <button
          className="button button--primary"
          onClick={() => window.location.reload()}
          type="button"
        >
          Reload Responder
        </button>
      </section>
    </main>
  );
}
