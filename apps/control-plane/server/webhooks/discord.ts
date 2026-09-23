import { createPublicKey, verify } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { findAutomationsForDiscordCommand } from "../../../../packages/core/src/db/automations.js";
import { queueAutomationRun } from "../automations/queue.js";

const discordCommandSchema = z.object({
  application_id: z.string().min(1),
  channel_id: z.string().min(1),
  data: z.object({
    name: z.literal("automate"),
    options: z
      .array(
        z.object({
          name: z.literal("context"),
          type: z.literal(3),
          value: z.string().max(4_000),
        }),
      )
      .optional()
      .default([]),
  }),
  guild_id: z.string().min(1),
  id: z.string().min(1),
  member: z
    .object({
      user: z.object({
        global_name: z.string().nullable().optional(),
        id: z.string().min(1),
        username: z.string().min(1),
      }),
    })
    .optional(),
  token: z.string().min(1),
  type: z.literal(2),
});

export function verifyDiscordSignature(input: {
  publicKey?: string;
  rawBody: string;
  signature: string | undefined;
  timestamp: string | undefined;
}): boolean {
  const publicKey = input.publicKey ?? process.env.DISCORD_PUBLIC_KEY;
  if (
    !publicKey ||
    !input.signature ||
    !input.timestamp ||
    !/^[0-9a-f]{64}$/iu.test(publicKey) ||
    !/^[0-9a-f]{128}$/iu.test(input.signature)
  ) {
    return false;
  }

  try {
    const key = createPublicKey({
      format: "der",
      type: "spki",
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(publicKey, "hex"),
      ]),
    });
    return verify(
      null,
      Buffer.from(`${input.timestamp}${input.rawBody}`, "utf8"),
      key,
      Buffer.from(input.signature, "hex"),
    );
  } catch {
    return false;
  }
}

function interactionResponse(content: string) {
  return {
    type: 4,
    data: {
      content,
      flags: 64,
    },
  };
}

function deferredInteractionResponse() {
  return { data: { flags: 64 }, type: 5 };
}

async function updateInteractionResponse(input: {
  applicationId: string;
  content: string;
  token: string;
}): Promise<void> {
  const response = await fetch(
    `https://discord.com/api/v10/webhooks/${encodeURIComponent(input.applicationId)}/${encodeURIComponent(input.token)}/messages/@original`,
    {
      body: JSON.stringify({ content: input.content }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    },
  );
  if (!response.ok) {
    throw new Error(`Discord interaction update failed (${response.status})`);
  }
}

async function fanOutDiscordCommand(
  interaction: z.infer<typeof discordCommandSchema>,
): Promise<void> {
  let content: string;
  try {
    const matches = await findAutomationsForDiscordCommand({
      channelId: interaction.channel_id,
      guildId: interaction.guild_id,
    });
    const commandContext = interaction.data.options.find(
      (option) => option.name === "context",
    )?.value.trim();
    const user = interaction.member?.user;
    const results = await Promise.allSettled(
      matches.map((match) =>
        queueAutomationRun({
          automationId: match.automationId,
          trigger: {
            attributes: {
              applicationId: interaction.application_id,
              channelId: interaction.channel_id,
              guildId: interaction.guild_id,
              interactionId: interaction.id,
              userId: user?.id ?? null,
              username: user?.global_name ?? user?.username ?? null,
            },
            body: commandContext ||
              "The automation was started with the /automate command.",
            externalEventId: `${interaction.id}:${match.automationId}`,
            provider: "discord",
            sourceUrl:
              `https://discord.com/channels/${interaction.guild_id}/${interaction.channel_id}`,
            title: user
              ? `Discord automation requested by ${user.global_name ?? user.username}`
              : "Discord automation requested",
          },
        })
      ),
    );
    const started = results.filter((result) => result.status === "fulfilled").length;
    const failed = results.length - started;
    content = matches.length === 0
      ? "No automation is configured for this channel."
      : failed === 0
        ? started === 1 ? "Automation started." : `${started} automations started.`
        : started === 0
          ? "The configured automations could not be started."
          : `${started} automations started; ${failed} could not be started.`;
  } catch (error) {
    console.error("Unable to fan out Discord automation command", error);
    content = "The configured automations could not be started.";
  }
  await updateInteractionResponse({
    applicationId: interaction.application_id,
    content,
    token: interaction.token,
  });
}

export const discordWebhookRoutes = new Hono().post("/", async (context) => {
  const rawBody = await context.req.text();
  if (
    !verifyDiscordSignature({
      rawBody,
      signature: context.req.header("x-signature-ed25519"),
      timestamp: context.req.header("x-signature-timestamp"),
    })
  ) {
    return context.json({ error: "Invalid Discord signature" }, 401);
  }

  let rawInteraction: unknown;
  try {
    rawInteraction = JSON.parse(rawBody) as unknown;
  } catch {
    return context.json({ error: "Invalid Discord payload" }, 400);
  }
  if (
    rawInteraction &&
    typeof rawInteraction === "object" &&
    "type" in rawInteraction &&
    rawInteraction.type === 1
  ) {
    return context.json({ type: 1 });
  }

  const parsed = discordCommandSchema.safeParse(rawInteraction);
  if (!parsed.success) {
    return context.json(
      interactionResponse("This command is not a supported automation trigger."),
    );
  }

  void fanOutDiscordCommand(parsed.data).catch((error) => {
    console.error("Unable to update Discord automation command", error);
  });
  return context.json(deferredInteractionResponse());
});
