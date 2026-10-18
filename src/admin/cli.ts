import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { hashToken, mintToken } from "../auth/tokens.js";
import { agentNameSchema } from "../bus/schemas.js";
import { parseAgentRegistration } from "../bus/service.js";
import { DEFAULTS, loadConfig } from "../config.js";
import { createStoreFromEnv } from "../db/create-store.js";
import type { Store } from "../db/types.js";
import { BusError } from "../errors.js";
import { assertAdminSecret, loadDotEnv } from "../env.js";
import { assertWebhookSecret, assertWebhookUrl } from "../wake/url.js";

export type AdminIo = {
  store: Store;
  adminSecret: string | undefined;
  ownerName?: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
};

function usage(): string {
  return [
    "Usage:",
    "  npm run admin -- register --name <name> [--description <text>]",
    "  npm run admin -- revoke --name <name>",
    "  npm run admin -- list",
    "  npm run admin -- ensure-owner",
    "  npm run admin -- seed-room [--name general] --members <name,name,...>",
    "  npm run admin -- set-webhook --name <agent> --url <https://...> --secret <16+ chars>",
    "  npm run admin -- clear-webhook --name <agent>",
    "",
    "Requires ADMIN_SECRET (16+ characters) and either DATABASE_URL or the Supabase service-role pair.",
    "ensure-owner uses OWNER_NAME (default owner) and does not print a token.",
  ].join("\n");
}

export async function runAdmin(argv: string[], io: AdminIo): Promise<number> {
  try {
    assertAdminSecret(io.adminSecret);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : "ADMIN_SECRET is missing");
    return 1;
  }

  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help") {
    io.stderr(usage());
    return command ? 0 : 1;
  }

  let values: { name?: string; description?: string; members?: string; url?: string; secret?: string };
  try {
    const parsed = parseArgs({
      args: rest,
      options: {
        name: { type: "string" },
        description: { type: "string" },
        members: { type: "string" },
        url: { type: "string" },
        secret: { type: "string" },
      },
      strict: true,
    });
    values = parsed.values;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : "Could not parse arguments");
    io.stderr(usage());
    return 1;
  }

  try {
    if (command === "list") {
      const agents = await io.store.listAgents(true);
      if (agents.length === 0) {
        io.stdout("No agents.");
        return 0;
      }
      for (const agent of agents) {
        const state = agent.revokedAt ? `revoked ${agent.revokedAt}` : "active";
        const kind = agent.isHuman ? "human" : "agent";
        io.stdout(`${agent.name}\t${agent.id}\t${kind}\t${state}`);
      }
      return 0;
    }

    if (command === "ensure-owner") {
      return await ensureOwner(io);
    }

    if (command === "seed-room") {
      return await seedRoom(io, values.name, values.members);
    }

    if (command === "set-webhook") {
      return await setWebhook(io, values.name, values.url, values.secret);
    }

    if (command === "clear-webhook") {
      return await clearWebhook(io, values.name);
    }

    if (command !== "register" && command !== "revoke") {
      io.stderr(`Unknown command ${command}`);
      io.stderr(usage());
      return 1;
    }

    if (!values.name) {
      io.stderr("--name is required");
      return 1;
    }

    if (command === "revoke") {
      const agent = await io.store.revokeAgentByName(values.name);
      if (!agent) {
        io.stderr(`No agent named ${values.name}`);
        return 1;
      }
      io.stdout(`${agent.name} revoked`);
      return 0;
    }

    const description = values.description ?? "";
    const parsed = parseAgentRegistration(values.name, description, DEFAULTS.maxDescriptionLength);
    const token = mintToken();
    const tokenHash = hashToken(token);
    const existing = await io.store.getAgentByName(parsed.name);
    const agent = existing?.revokedAt
      ? await io.store.restoreAgent({
          name: parsed.name,
          description: values.description === undefined ? existing.description : parsed.description,
          tokenHash,
        })
      : await io.store.insertAgent({ ...parsed, tokenHash });
    if (!agent) {
      io.stderr(`Could not register ${parsed.name}`);
      return 1;
    }
    io.stderr("Save this token now. It will not be shown again.");
    io.stdout(`name: ${agent.name}`);
    io.stdout(`id: ${agent.id}`);
    io.stdout(`token: ${token}`);
    return 0;
  } catch (error) {
    if (error instanceof BusError) {
      io.stderr(error.message);
      return 1;
    }
    io.stderr(error instanceof Error ? error.message : "Admin command failed");
    return 1;
  }
}

async function ensureOwner(io: AdminIo): Promise<number> {
  const name = agentNameSchema.parse(io.ownerName ?? DEFAULTS.ownerName);
  const existing = await io.store.getAgentByName(name);
  if (existing?.revokedAt) {
    const restored = await io.store.restoreAgent({
      name,
      description: existing.description,
      tokenHash: existing.tokenHash,
    });
    if (!restored) {
      io.stderr(`Could not restore ${name}.`);
      return 1;
    }
  }
  if (!existing) {
    await io.store.insertAgent({
      name,
      description: "Human owner of this bus",
      tokenHash: hashToken(mintToken()),
      isHuman: true,
    });
  }
  const owner = await io.store.markHuman(name);
  if (!owner) {
    io.stderr(`Could not mark ${name} as human.`);
    return 1;
  }
  io.stdout(`human: ${owner.name}`);
  io.stdout(`id: ${owner.id}`);
  io.stderr("No token was printed. The owner signs in at /chat with OWNER_PASSWORD.");
  return 0;
}

async function setWebhook(
  io: AdminIo,
  name: string | undefined,
  url: string | undefined,
  secret: string | undefined,
): Promise<number> {
  if (!name || !url || !secret) {
    io.stderr("--name, --url, and --secret are required");
    return 1;
  }
  const agentName = agentNameSchema.parse(name);
  const agent = await io.store.getAgentByName(agentName);
  if (!agent || agent.revokedAt) {
    io.stderr(`No active agent named ${agentName}`);
    return 1;
  }
  const saved = await io.store.setWebhook(agent.id, assertWebhookUrl(url), assertWebhookSecret(secret));
  io.stdout(`webhook: ${agent.name}`);
  io.stdout(`url: ${saved.url}`);
  io.stderr("The signing secret was stored and will not be shown again.");
  return 0;
}

async function clearWebhook(io: AdminIo, name: string | undefined): Promise<number> {
  if (!name) {
    io.stderr("--name is required");
    return 1;
  }
  const agentName = agentNameSchema.parse(name);
  const agent = await io.store.getAgentByName(agentName);
  if (!agent) {
    io.stderr(`No agent named ${agentName}`);
    return 1;
  }
  const cleared = await io.store.clearWebhook(agent.id);
  io.stdout(cleared ? `webhook cleared: ${agent.name}` : `no webhook set for ${agent.name}`);
  return 0;
}

async function seedRoom(io: AdminIo, name: string | undefined, members: string | undefined): Promise<number> {
  const roomName = agentNameSchema.parse(name?.trim() || "general");
  const wanted = (members ?? "")
    .split(",")
    .map((member) => member.trim())
    .filter((member) => member.length > 0);
  if (wanted.length === 0) {
    io.stderr("--members is required, for example --members owner,codex,claude,grok");
    return 1;
  }
  let room = await io.store.getRoomByName(roomName);
  if (!room) {
    try {
      room = await io.store.createRoom(roomName);
    } catch (error) {
      if (!(error instanceof BusError) || error.code !== "conflict") throw error;
      room = await io.store.getRoomByName(roomName);
    }
  }
  if (!room) {
    io.stderr(`Could not create room ${roomName}`);
    return 1;
  }
  const missing: string[] = [];
  for (const member of wanted) {
    const agent = await io.store.getAgentByName(member);
    if (!agent || agent.revokedAt) {
      missing.push(member);
      continue;
    }
    await io.store.addRoomMember(room.id, agent.id);
    io.stdout(`member: ${agent.name}`);
  }
  io.stdout(`room: ${room.name}`);
  if (missing.length > 0) {
    io.stderr(`Missing agents: ${missing.join(", ")}. Register them, then run seed-room again.`);
    return 1;
  }
  return 0;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return fileURLToPath(import.meta.url) === entry;
}

async function main(): Promise<void> {
  loadDotEnv();
  const store = createStoreFromEnv(process.env);
  const code = await runAdmin(process.argv.slice(2), {
    store,
    adminSecret: process.env.ADMIN_SECRET,
    ownerName: loadConfig(process.env).ownerName,
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  });
  process.exit(code);
}

if (isDirectRun()) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Admin command failed");
    process.exit(1);
  });
}
