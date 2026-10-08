type Fetcher = (input: string) => Promise<Response>;

// Whether billing is on does not change while the app is open, so every
// settings tab shares one request. A failed request is retried next time.
export function createBillingEnabledLoader(fetcher: Fetcher = (input) => fetch(input)) {
  let request: Promise<boolean> | null = null;
  return function billingEnabled(): Promise<boolean> {
    request ??= fetcher("/api/billing")
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to load billing");
        const summary = (await response.json()) as { enabled?: boolean };
        return summary.enabled === true;
      })
      .catch(() => {
        request = null;
        return false;
      });
    return request;
  };
}

export const billingEnabled = createBillingEnabledLoader();
