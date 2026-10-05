import { z } from "zod";

// Buttons an automation's agent adds to a Slack message it posts, so people
// can choose what the run does next. Pressing one continues the run with a
// message that names the button. The first press on a message is the choice:
// the buttons are then replaced with who pressed which one.

export const automationButtonActionPrefix = "automation_run_button:";
export const automationButtonsBlockId = "automation_run_buttons";
export const maxAutomationButtons = 5;
// Slack's limit for a button's text.
export const maxAutomationButtonLabelLength = 75;

export const automationButtonsSchema = z.array(z.object({
  label: z.string().trim().min(1).max(maxAutomationButtonLabelLength),
  style: z.enum(["danger", "primary"]).optional(),
}).strict())
  .max(maxAutomationButtons)
  .refine(
    (buttons) => new Set(buttons.map((button) => button.label)).size === buttons.length,
    "Each button needs its own label",
  );

export type AutomationButton = z.infer<typeof automationButtonsSchema>[number];

export const automationButtonsDescription = `Buttons under the message, at most ${maxAutomationButtons}, for example [{"label":"Create PR","style":"primary"}]. Add them only when the automation's instructions ask people to decide what happens next. Pressing one continues this run with a message naming the button and who pressed it, so end your turn after posting instead of waiting. Only the first press on a message counts.`;

// The JSON schema of the buttons tool argument.
export const automationButtonsInputSchema = {
  description: automationButtonsDescription,
  items: {
    additionalProperties: false,
    properties: {
      label: { maxLength: maxAutomationButtonLabelLength, minLength: 1, type: "string" },
      style: { enum: ["primary", "danger"], type: "string" },
    },
    required: ["label"],
    type: "object",
  },
  maxItems: maxAutomationButtons,
  type: "array",
};

// Each button names the run in its value and its position in its action ID,
// which must be unique within the block.
export function automationButtonsBlock(runId: string, buttons: AutomationButton[]) {
  return {
    block_id: automationButtonsBlockId,
    elements: buttons.map((button, index) => ({
      action_id: `${automationButtonActionPrefix}${index}`,
      text: { emoji: true, text: button.label, type: "plain_text" },
      type: "button",
      value: runId,
      ...(button.style ? { style: button.style } : {}),
    })),
    type: "actions",
  };
}

export function automationButtonIndex(actionId: string): number | null {
  if (!actionId.startsWith(automationButtonActionPrefix)) return null;
  const suffix = actionId.slice(automationButtonActionPrefix.length);
  if (!/^\d$/u.test(suffix)) return null;
  const index = Number(suffix);
  return index < maxAutomationButtons ? index : null;
}

// The message's blocks with its buttons replaced by who pressed which one.
// The label is plain text, so Slack shows it as the agent wrote it.
export function pressedAutomationButtonBlocks(
  blocks: unknown[],
  pressed: { label: string; userId: string },
): unknown[] {
  return [
    ...blocks.filter((block) =>
      (block as { block_id?: unknown } | null)?.block_id !== automationButtonsBlockId
    ),
    {
      elements: [
        { text: `<@${pressed.userId}> pressed`, type: "mrkdwn" },
        { emoji: true, text: pressed.label, type: "plain_text" },
      ],
      type: "context",
    },
  ];
}
