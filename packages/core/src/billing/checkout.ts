// Extra Stripe Checkout session fields for plan purchases. Autumn deep-merges
// them into the session it creates, so keys use Stripe's snake_case names.
//
// Buyers can mark the purchase as a business and enter the legal name and a
// tax ID. The billing address is always collected so invoices carry it.
// Autumn passes an existing Stripe customer, so Stripe saves the name and
// address back to that customer only when customer_update allows it.
export const businessCheckoutSessionParams = {
  billing_address_collection: "required",
  customer_update: { address: "auto", name: "auto" },
  tax_id_collection: { enabled: true, required: "never" },
} as const;
