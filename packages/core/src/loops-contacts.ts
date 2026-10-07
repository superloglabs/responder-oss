export interface LoopsSignupContact {
  email: string;
  name?: string | null;
}

const loopsContactsUrl = "https://app.loops.so/api/v1/contacts/update";

function splitName(name: string | null | undefined): {
  firstName?: string;
  lastName?: string;
} {
  const parts = name?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (parts.length === 0) return {};
  const [firstName, ...rest] = parts;
  return rest.length > 0
    ? { firstName, lastName: rest.join(" ") }
    : { firstName };
}

/**
 * Adds a new account to the Loops audience so onboarding emails can start.
 * The update endpoint creates the contact when it is missing. An existing
 * contact, such as someone who signed up to another product on the same
 * Loops team, is updated instead, which does not start a "contact added" loop
 * again and leaves their subscription choice alone. The contact is keyed by
 * email only: a Loops user id from another product would conflict.
 * Delivery failures are logged without failing account creation.
 */
export async function syncLoopsSignupContact(
  input: LoopsSignupContact,
): Promise<void> {
  const apiKey = process.env.LOOPS_API_KEY?.trim();
  if (!apiKey) return;

  const email = input.email.trim().toLowerCase();
  if (!email) return;

  try {
    const response = await fetch(loopsContactsUrl, {
      body: JSON.stringify({
        email,
        ...splitName(input.name),
        source: "Responder",
        userGroup: "Users",
      }),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      method: "PUT",
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) {
      throw new Error(`Loops API responded with status ${response.status}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`Unable to add signup to Loops: ${message}`);
  }
}
