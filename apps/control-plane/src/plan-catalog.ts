// Plans listed when a workspace compares plans on the billing page. Hosted
// composition replaces this file with the edition's catalog, which its
// pricing page also reads. Keep the export name and type identical.

import type { PlanCatalog } from "./plan-comparison";

export const planCatalog: PlanCatalog = {
  intro:
    "Every plan works with your own API key or ChatGPT subscription. Paid plans add usage credit and more machine hours.",
  plans: [
    {
      action: "Get started free",
      audience: "For trying it out",
      badge: "No card required",
      billingPlanId: "free",
      description: "$5 of usage credit to try it and 2 machine hours a month.",
      id: "free",
      label: "Trying it out",
      name: "Free",
      price: "$0",
      unit: "/ month",
    },
    {
      action: "Get started with Pro",
      audience: "For developers using it daily",
      badge: "$100 of usage included",
      billingPlanId: "responder_plan_pro",
      description: "$100 of usage credit and 50 machine hours every month.",
      id: "pro",
      label: "Daily use",
      name: "Pro",
      price: "$100",
      unit: "/ month",
    },
    {
      action: "Get started with Team",
      audience: "For teams running automations",
      badge: "500 machine hours",
      billingPlanId: "responder_plan_team",
      description: "$200 of usage credit and 500 machine hours every month.",
      id: "team",
      label: "Shared automations",
      name: "Team",
      price: "$200",
      recommended: true,
      unit: "/ month",
    },
  ],
  comparison: [
    {
      title: "AI models",
      rows: [
        { label: "Bring your own API key", values: [true, true, true] },
        {
          label: "Bring your own subscription",
          note: "ChatGPT and Codex",
          values: [true, true, true],
        },
        { label: "Usage credit", values: ["$5 (one-time grant)", "$100 / mo", "$200 / mo"] },
      ],
    },
    {
      title: "Machines",
      rows: [
        { label: "Machine hours", values: ["2 hrs / mo", "50 hrs / mo", "500 hrs / mo"] },
      ],
    },
  ],
  questions: [
    {
      question: "What happens when my usage credit runs out?",
      answer:
        "Paid plans bill usage past the credit at the end of the period. On Free, runs that use the credit stop until you upgrade. Runs with your own API key or ChatGPT subscription keep working.",
    },
    {
      question: "What happens when my machine hours run out?",
      answer:
        "Paid plans bill extra hours per hour at the end of the period. On Free, runs in progress finish and new runs wait until the hours reset at the start of the next month.",
    },
  ],
};
