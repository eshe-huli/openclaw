/**
 * Ringforge OpenClaw Plugin
 *
 * Connects any OpenClaw agent to a Ringforge fleet with just config:
 *
 *   plugins:
 *     entries:
 *       ringforge:
 *         enabled: true
 *         config:
 *           server: "wss://ringforge.wejoona.com"
 *           apiKey: "rf_live_..."
 *           fleetId: "default"
 *           agentName: "My Agent"
 *           capabilities: ["code", "research"]
 *
 * The plugin:
 * - Starts a persistent WebSocket connection to the hub on gateway_start
 * - Registers tools so the LLM can send messages, check roster, broadcast activity
 * - Routes incoming DMs into the agent's pending message queue
 * - Auto-reconnects on disconnect
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { RingforgeClient, type RingforgeConfig } from "./src/client.js";
import { createRingforgeTools, updateRoster, pushIncomingMessage } from "./src/tools.js";

let client: RingforgeClient | null = null;

function resolveConfig(
  pluginConfig: Record<string, unknown> | undefined,
  agentName?: string,
): RingforgeConfig | null {
  if (!pluginConfig) return null;
  if (pluginConfig.enabled === false) return null;

  const server = pluginConfig.server as string;
  const apiKey = pluginConfig.apiKey as string;
  const fleetId = (pluginConfig.fleetId as string) || "default";

  if (!server || !apiKey) return null;

  return {
    server,
    apiKey,
    fleetId,
    agentName:
      (pluginConfig.agentName as string) ||
      agentName ||
      `openclaw-${Math.random().toString(36).slice(2, 8)}`,
    framework: "openclaw",
    capabilities: (pluginConfig.capabilities as string[]) || [],
    model: (pluginConfig.model as string) || undefined,
  };
}

function formatDmAsSystemEvent(
  from: { name?: string; agent_id: string },
  message: Record<string, unknown>,
): string {
  const fromName = from.name || from.agent_id;
  const type = (message.type as string) || "text";

  switch (type) {
    case "text":
      return `[Ringforge DM] ${fromName}: ${message.text}`;

    case "task_request":
      return `[Ringforge Task] ${fromName} assigned task "${message.task}": ${message.description || ""}${message.priority === "high" ? " ⚡ HIGH PRIORITY" : ""}`;

    case "query":
      return `[Ringforge Query] ${fromName} asks: ${message.question}`;

    case "status_request":
      return `[Ringforge] ${fromName} requests your status. Reply using ringforge_send.`;

    case "data":
      return `[Ringforge Data] ${fromName} sent data "${message.label}": ${JSON.stringify(message.payload).slice(0, 500)}`;

    case "task_result":
      return `[Ringforge Result] ${fromName} completed task (ref=${message.ref}): ${JSON.stringify(message.result).slice(0, 500)}`;

    default:
      return `[Ringforge DM] ${fromName} [${type}]: ${JSON.stringify(message).slice(0, 500)}`;
  }
}

const ringforgePlugin = {
  id: "ringforge",
  name: "Ringforge",
  description: "Connect to a Ringforge agent mesh fleet",
  version: "0.1.0",

  configSchema: {
    parse(value: unknown) {
      if (!value || typeof value !== "object") return {};
      return value;
    },
    uiHints: {
      enabled: { label: "Enabled", help: "Enable Ringforge mesh connection" },
      server: {
        label: "Server URL",
        placeholder: "wss://ringforge.wejoona.com",
      },
      apiKey: {
        label: "API Key",
        sensitive: true,
        placeholder: "rf_live_...",
      },
      fleetId: { label: "Fleet ID" },
      agentName: {
        label: "Agent Name",
        help: "Display name in the mesh",
      },
      capabilities: {
        label: "Capabilities",
        help: "Comma-separated list",
      },
    },
  },

  register(api: OpenClawPluginApi) {
    const config = resolveConfig(api.pluginConfig, api.config?.identity?.agentName || api.name);

    if (!config) {
      api.logger.info("Ringforge: disabled or missing config (need server, apiKey)");
      return;
    }

    // Create client
    client = new RingforgeClient(config, {
      onConnected: (agentId) => {
        api.logger.info(`Ringforge: connected as ${config.agentName} (${agentId})`);
      },
      onDisconnected: (reason) => {
        api.logger.info(`Ringforge: disconnected (${reason}), reconnecting...`);
      },
      onDirectMessage: (from, message) => {
        const fromName = from.name || from.agent_id;
        const preview =
          message.type === "text"
            ? (message.text as string)
            : JSON.stringify(message).slice(0, 100);
        api.logger.info(`Ringforge DM from ${fromName}: ${preview}`);
        pushIncomingMessage(from, message);

        // DM → Agent Turn Injection: inject as system event so the LLM processes it
        // Default to "immediate" — agents should auto-respond like Telegram bots
        const injection = (message as Record<string, unknown>).injection || "immediate";
        const priority = (message as Record<string, unknown>).priority || "normal";

        if (injection !== "silent") {
          // Immediate injection — trigger agent turn so the LLM processes and responds
          const eventText = formatDmAsSystemEvent(from, message);
          const sessionKey = "agent:main:main";

          try {
            api.runtime.system.enqueueSystemEvent(eventText, { sessionKey });
            api.logger.info(`Ringforge: injected DM from ${fromName} as system event`);
          } catch (err) {
            api.logger.warn(`Ringforge: failed to inject DM as system event: ${err}`);
          }
        }
        // "silent" mode: message stays in inbox only, agent checks via ringforge_inbox tool
      },
      onRoster: (agents) => {
        updateRoster(agents);
        api.logger.info(`Ringforge: roster updated (${agents.length} agents)`);
      },
      onPresenceJoined: (agent) => {
        api.logger.info(`Ringforge: ${agent.name || agent.agent_id} joined`);
      },
      onPresenceLeft: (agentId) => {
        api.logger.info(`Ringforge: ${agentId} left`);
      },
      onActivity: (activity) => {
        const kind = activity.kind || "unknown";
        const desc = activity.description || "";
        api.logger.info(`Ringforge activity: [${kind}] ${desc}`);
      },
    });

    // Register tools
    const tools = createRingforgeTools(client);
    for (const tool of tools) {
      api.registerTool(tool as any, { name: tool.name });
    }

    // Register /ringforge command
    api.registerCommand({
      name: "ringforge",
      description: "Ringforge mesh status",
      handler: () => {
        if (!client) return { text: "Ringforge: not configured" };
        const status = client.isConnected ? "🟢 Connected" : "🔴 Disconnected";
        const id = client.currentAgentId || "unknown";
        const uptime = Math.floor(client.uptimeMs / 1000);
        return {
          text: `Ringforge: ${status}\nAgent: ${config.agentName} (${id})\nFleet: ${config.fleetId}\nUptime: ${uptime}s`,
        };
      },
    });

    // Start connection as a service
    api.registerService({
      id: "ringforge-mesh",
      start: () => {
        api.logger.info(`Ringforge: connecting to ${config.server} as "${config.agentName}"...`);
        client!.connect();
      },
      stop: () => {
        api.logger.info("Ringforge: disconnecting...");
        client!.disconnect();
      },
    });
  },
};

export default ringforgePlugin;
