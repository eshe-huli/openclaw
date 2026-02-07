/**
 * Ringforge agent tools — exposed to the LLM so it can interact with the mesh.
 *
 * Each tool conforms to the AgentTool interface from pi-agent-core:
 *   { name, label, description, parameters, execute(toolCallId, params, signal?) }
 *   execute returns { content: [{ type: "text", text: "..." }], details: ... }
 */

import type { RingforgeClient, RingforgeAgent, RingforgeMessage } from "./client.js";

type ToolContent = { type: "text"; text: string };
type ToolResult = { content: ToolContent[]; details: unknown };

// Store roster state for tool queries
let lastRoster: RingforgeAgent[] = [];
let pendingMessages: Array<{
  from: string;
  fromName: string;
  message: RingforgeMessage;
  ts: number;
}> = [];
const MAX_PENDING = 50;

export function updateRoster(agents: RingforgeAgent[]): void {
  lastRoster = agents;
}

export function pushIncomingMessage(from: RingforgeAgent, message: RingforgeMessage): void {
  pendingMessages.push({
    from: from.agent_id,
    fromName: from.name || from.agent_id,
    message,
    ts: Date.now(),
  });
  if (pendingMessages.length > MAX_PENDING) {
    pendingMessages = pendingMessages.slice(-MAX_PENDING);
  }
}

function textResult(text: string): ToolResult {
  return {
    content: [{ type: "text", text }],
    details: { text },
  };
}

export function createRingforgeTools(client: RingforgeClient) {
  return [
    {
      name: "ringforge_roster",
      label: "Ringforge Roster",
      description:
        "List agents currently online in the Ringforge fleet. Returns agent IDs, names, states, and capabilities.",
      parameters: {
        type: "object" as const,
        properties: {},
        required: [] as string[],
      },
      execute: async (
        _toolCallId: string,
        _params: Record<string, unknown>,
      ): Promise<ToolResult> => {
        client.requestRoster();
        // Return cached roster (updated async via handler)
        if (lastRoster.length === 0) {
          return textResult(
            "No agents in roster yet. The fleet may be empty or roster hasn't been received.",
          );
        }
        const lines = lastRoster.map(
          (a) =>
            `- ${a.name || a.agent_id} (${a.agent_id}) — state: ${a.state}${a.task ? `, task: ${a.task}` : ""}, capabilities: [${(a.capabilities || []).join(", ")}]`,
        );
        return textResult(`Fleet roster (${lastRoster.length} agents):\n${lines.join("\n")}`);
      },
    },

    {
      name: "ringforge_send",
      label: "Ringforge Send",
      description:
        "Send a direct message to another agent in the Ringforge mesh. Supports text messages and structured payloads (task_request, query, data, status_request).",
      parameters: {
        type: "object" as const,
        properties: {
          agent_id: {
            type: "string",
            description: "Target agent ID (e.g. ag_xxx). Use ringforge_roster to find IDs.",
          },
          message: {
            type: "string",
            description:
              'Message text for simple DMs, OR a JSON string for structured messages. Structured types: {"type":"task_request","task":"name","description":"..."} or {"type":"query","question":"..."} or {"type":"data","label":"name","payload":{...}}',
          },
        },
        required: ["agent_id", "message"],
      },
      execute: async (
        _toolCallId: string,
        params: { agent_id: string; message: string },
      ): Promise<ToolResult> => {
        if (!client.isConnected) {
          return textResult("Not connected to Ringforge mesh.");
        }

        let msg: RingforgeMessage;
        try {
          msg = JSON.parse(params.message) as RingforgeMessage;
          if (!msg.type) msg.type = "text";
        } catch {
          msg = { type: "text", text: params.message };
        }

        client.sendDM(params.agent_id, msg);
        return textResult(
          `Message sent to ${params.agent_id}: ${JSON.stringify(msg).slice(0, 200)}`,
        );
      },
    },

    {
      name: "ringforge_inbox",
      label: "Ringforge Inbox",
      description:
        "Check incoming messages from other agents in the Ringforge mesh. Returns unread messages and clears the inbox.",
      parameters: {
        type: "object" as const,
        properties: {
          limit: {
            type: "number",
            description: "Max messages to return (default 10)",
          },
        },
        required: [] as string[],
      },
      execute: async (_toolCallId: string, params: { limit?: number }): Promise<ToolResult> => {
        const limit = params.limit || 10;
        const messages = pendingMessages.splice(0, limit);

        if (messages.length === 0) {
          return textResult("No new messages in Ringforge inbox.");
        }

        const lines = messages.map((m) => {
          const age = Math.floor((Date.now() - m.ts) / 1000);
          const body =
            m.message.type === "text" ? (m.message.text as string) : JSON.stringify(m.message);
          return `[${age}s ago] ${m.fromName}: ${body}`;
        });

        return textResult(
          `${messages.length} message(s) from Ringforge:\n${lines.join("\n")}${pendingMessages.length > 0 ? `\n(${pendingMessages.length} more in queue)` : ""}`,
        );
      },
    },

    {
      name: "ringforge_activity",
      label: "Ringforge Activity",
      description:
        "Broadcast an activity event to the entire fleet (visible to all agents and dashboard).",
      parameters: {
        type: "object" as const,
        properties: {
          kind: {
            type: "string",
            description:
              "Activity kind: task_started, task_completed, task_failed, discovery, question, alert, custom",
          },
          description: {
            type: "string",
            description: "Description of the activity",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Optional tags for filtering",
          },
        },
        required: ["kind", "description"],
      },
      execute: async (
        _toolCallId: string,
        params: { kind: string; description: string; tags?: string[] },
      ): Promise<ToolResult> => {
        if (!client.isConnected) {
          return textResult("Not connected to Ringforge mesh.");
        }
        client.broadcastActivity(params.kind, params.description, params.tags || []);
        return textResult(`Activity broadcast: [${params.kind}] ${params.description}`);
      },
    },

    {
      name: "ringforge_presence",
      label: "Ringforge Presence",
      description:
        "Update your presence state in the mesh (online, busy, away) with optional task description.",
      parameters: {
        type: "object" as const,
        properties: {
          state: {
            type: "string",
            description: "State: online, busy, or away",
          },
          task: {
            type: "string",
            description: "Optional: current task description (shown to other agents)",
          },
        },
        required: ["state"],
      },
      execute: async (
        _toolCallId: string,
        params: { state: string; task?: string },
      ): Promise<ToolResult> => {
        if (!client.isConnected) {
          return textResult("Not connected to Ringforge mesh.");
        }
        client.updatePresence(params.state, params.task);
        return textResult(
          `Presence updated: ${params.state}${params.task ? ` (${params.task})` : ""}`,
        );
      },
    },

    {
      name: "ringforge_memory",
      label: "Ringforge Memory",
      description: "Read or write shared fleet memory (key-value store accessible by all agents).",
      parameters: {
        type: "object" as const,
        properties: {
          action: {
            type: "string",
            description: "Action: set or get",
          },
          key: {
            type: "string",
            description: "Memory key",
          },
          value: {
            type: "string",
            description: "Value to set (for action=set). Will be stored as-is.",
          },
        },
        required: ["action", "key"],
      },
      execute: async (
        _toolCallId: string,
        params: { action: string; key: string; value?: string },
      ): Promise<ToolResult> => {
        if (!client.isConnected) {
          return textResult("Not connected to Ringforge mesh.");
        }
        if (params.action === "set") {
          client.setMemory(params.key, params.value || "");
          return textResult(`Memory set: ${params.key}`);
        } else if (params.action === "get") {
          try {
            const reply = await client.getMemoryAsync(params.key);
            const value = reply?.value ?? reply?.result ?? reply;
            return textResult(`Memory[${params.key}]: ${JSON.stringify(value).slice(0, 1000)}`);
          } catch (err) {
            return textResult(
              `Memory get failed for "${params.key}": ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        return textResult(`Unknown action: ${params.action}. Use 'set' or 'get'.`);
      },
    },
  ];
}
