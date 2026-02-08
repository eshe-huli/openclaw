/**
 * Ringforge agent tools — exposed to the LLM for mesh interaction.
 *
 * Tools: roster, send, inbox, activity, presence, memory,
 *        kanban, context, task_update
 */

import type { RingforgeClient, RingforgeAgent, RingforgeMessage } from "./client.js";
import type { ContextManager } from "./context-manager.js";

type ToolContent = { type: "text"; text: string };
type ToolResult = { content: ToolContent[]; details: unknown };

// ── State ────────────────────────────────────────────────────

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

function text(t: string): ToolResult {
  return { content: [{ type: "text", text: t }], details: { text: t } };
}

// ── Tool Factory ─────────────────────────────────────────────

export function createRingforgeTools(client: RingforgeClient, ctxMgr?: ContextManager | null) {
  const notConnected = () => text("Not connected to Ringforge mesh.");

  return [
    // ── Roster ──
    {
      name: "ringforge_roster",
      label: "Ringforge Roster",
      description:
        "List agents currently online in the Ringforge fleet. Returns agent IDs, names, states, and capabilities.",
      parameters: { type: "object" as const, properties: {}, required: [] as string[] },
      execute: async (): Promise<ToolResult> => {
        client.requestRoster();
        if (lastRoster.length === 0) {
          return text("No agents in roster yet. Fleet may be empty or roster pending.");
        }
        const lines = lastRoster.map(
          (a) =>
            `- ${a.name || a.agent_id} (${a.agent_id}) — ${a.state}${a.model ? ` [${a.model}]` : ""}${a.task ? `, task: ${a.task}` : ""}, caps: [${(a.capabilities || []).join(", ")}]`,
        );
        return text(`Fleet roster (${lastRoster.length} agents):\n${lines.join("\n")}`);
      },
    },

    // ── Send DM ──
    {
      name: "ringforge_send",
      label: "Ringforge Send",
      description:
        'Send a DM to another agent. Text or structured: {"type":"task_request","task":"name","description":"..."}',
      parameters: {
        type: "object" as const,
        properties: {
          agent_id: { type: "string", description: "Target agent ID (e.g. ag_xxx)" },
          message: {
            type: "string",
            description: "Text message or JSON structured payload",
          },
        },
        required: ["agent_id", "message"],
      },
      execute: async (
        _id: string,
        params: { agent_id: string; message: string },
      ): Promise<ToolResult> => {
        if (!client.isConnected) return notConnected();

        let msg: RingforgeMessage;
        try {
          msg = JSON.parse(params.message) as RingforgeMessage;
          if (!msg.type) msg.type = "text";
        } catch {
          msg = { type: "text", text: params.message };
        }

        client.sendDM(params.agent_id, msg);
        return text(`Sent to ${params.agent_id}: ${JSON.stringify(msg).slice(0, 200)}`);
      },
    },

    // ── Inbox ──
    {
      name: "ringforge_inbox",
      label: "Ringforge Inbox",
      description: "Check incoming messages from other agents. Returns unread and clears inbox.",
      parameters: {
        type: "object" as const,
        properties: { limit: { type: "number", description: "Max messages (default 10)" } },
        required: [] as string[],
      },
      execute: async (_id: string, params: { limit?: number }): Promise<ToolResult> => {
        const limit = params.limit || 10;
        const msgs = pendingMessages.splice(0, limit);
        if (msgs.length === 0) return text("No new messages in Ringforge inbox.");

        const lines = msgs.map((m) => {
          const age = Math.floor((Date.now() - m.ts) / 1000);
          const body =
            m.message.type === "text" ? (m.message.text as string) : JSON.stringify(m.message);
          return `[${age}s ago] ${m.fromName}: ${body}`;
        });
        const more =
          pendingMessages.length > 0 ? `\n(${pendingMessages.length} more in queue)` : "";
        return text(`${msgs.length} message(s):\n${lines.join("\n")}${more}`);
      },
    },

    // ── Activity Broadcast ──
    {
      name: "ringforge_activity",
      label: "Ringforge Activity",
      description: "Broadcast an activity event to the fleet.",
      parameters: {
        type: "object" as const,
        properties: {
          kind: {
            type: "string",
            description:
              "Kind: task_started, task_completed, task_failed, discovery, question, alert, custom",
          },
          description: { type: "string", description: "Activity description" },
          tags: { type: "array", items: { type: "string" }, description: "Optional tags" },
        },
        required: ["kind", "description"],
      },
      execute: async (
        _id: string,
        params: { kind: string; description: string; tags?: string[] },
      ): Promise<ToolResult> => {
        if (!client.isConnected) return notConnected();
        client.broadcastActivity(params.kind, params.description, params.tags || []);
        return text(`Activity broadcast: [${params.kind}] ${params.description}`);
      },
    },

    // ── Presence ──
    {
      name: "ringforge_presence",
      label: "Ringforge Presence",
      description: "Update your presence state (online, busy, away) with optional task.",
      parameters: {
        type: "object" as const,
        properties: {
          state: { type: "string", description: "State: online, busy, away" },
          task: { type: "string", description: "Optional task description" },
        },
        required: ["state"],
      },
      execute: async (
        _id: string,
        params: { state: string; task?: string },
      ): Promise<ToolResult> => {
        if (!client.isConnected) return notConnected();
        client.updatePresence({ state: params.state, task: params.task });
        return text(`Presence: ${params.state}${params.task ? ` (${params.task})` : ""}`);
      },
    },

    // ── Memory ──
    {
      name: "ringforge_memory",
      label: "Ringforge Memory",
      description: "Read or write shared fleet memory (key-value store).",
      parameters: {
        type: "object" as const,
        properties: {
          action: { type: "string", description: "set or get" },
          key: { type: "string", description: "Memory key" },
          value: { type: "string", description: "Value to set (for set action)" },
        },
        required: ["action", "key"],
      },
      execute: async (
        _id: string,
        params: { action: string; key: string; value?: string },
      ): Promise<ToolResult> => {
        if (!client.isConnected) return notConnected();

        if (params.action === "set") {
          client.setMemory(params.key, params.value || "");
          return text(`Memory set: ${params.key}`);
        }
        if (params.action === "get") {
          try {
            const reply = await client.getMemoryAsync(params.key);
            const val = reply?.value ?? reply?.result ?? reply;
            return text(`Memory[${params.key}]: ${JSON.stringify(val).slice(0, 1000)}`);
          } catch (err) {
            return text(`Memory get failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        return text(`Unknown action: ${params.action}. Use 'set' or 'get'.`);
      },
    },

    // ── Kanban ──
    {
      name: "ringforge_kanban",
      label: "Ringforge Kanban",
      description:
        "Query the kanban board at agent, squad, or fleet level. Shows tasks, priorities, blockers.",
      parameters: {
        type: "object" as const,
        properties: {
          level: {
            type: "string",
            description: "agent (your tasks), squad (team), fleet (all). Default: agent",
          },
          squad_id: { type: "string", description: "Squad ID for squad-level (optional)" },
        },
        required: [] as string[],
      },
      execute: async (
        _id: string,
        params: { level?: string; squad_id?: string },
      ): Promise<ToolResult> => {
        if (!client.isConnected) return notConnected();
        try {
          const reply = await client.pushChannelAsync("context:kanban", {
            payload: { level: params.level || "agent", squad_id: params.squad_id },
          });
          const data = (reply as any)?.payload || reply;
          return text(formatKanban(data));
        } catch (err) {
          return text(`Kanban query failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },

    // ── Full Context ──
    {
      name: "ringforge_context",
      label: "Ringforge Context",
      description:
        "Get full context: tasks, role, squad, fleet priorities, artifacts, rules. Use when starting work or unsure what to do.",
      parameters: {
        type: "object" as const,
        properties: {
          include: { type: "string", description: "all, agent, squad, fleet. Default: all" },
        },
        required: [] as string[],
      },
      execute: async (_id: string, params: { include?: string }): Promise<ToolResult> => {
        // Try cached context first
        if (ctxMgr) {
          await ctxMgr.refresh();
          const prompt = ctxMgr.buildPromptContext();
          if (prompt) return text(prompt);
        }
        // Direct query fallback
        if (!client.isConnected) return notConnected();
        try {
          const reply = await client.pushChannelAsync("context:sync", {
            payload: { include: params.include || "all" },
          });
          const ctx = (reply as any)?.context || (reply as any)?.payload?.context || reply;
          return text(JSON.stringify(ctx, null, 2).slice(0, 3000));
        } catch (err) {
          return text(`Context sync failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },

    // ── Task Update ──
    {
      name: "ringforge_task_update",
      label: "Ringforge Task Update",
      description:
        "Update a kanban task: move lanes, update progress, or complete. Use to track work.",
      parameters: {
        type: "object" as const,
        properties: {
          task_id: { type: "string", description: "Task ID (e.g. T-001)" },
          action: { type: "string", description: "move, update, or complete" },
          lane: {
            type: "string",
            description: "Target lane for move: backlog, ready, in_progress, blocked, review, done",
          },
          progress: { type: "number", description: "Progress percentage (0-100)" },
          reason: { type: "string", description: "Reason (shown in history)" },
        },
        required: ["task_id", "action"],
      },
      execute: async (
        _id: string,
        params: {
          task_id: string;
          action: string;
          lane?: string;
          progress?: number;
          reason?: string;
        },
      ): Promise<ToolResult> => {
        if (!client.isConnected) return notConnected();

        try {
          const eventMap: Record<string, string> = {
            move: "kanban:move",
            update: "kanban:update",
            complete: "kanban:move",
          };
          const event = eventMap[params.action] || "kanban:update";

          const payload: Record<string, unknown> = { task_id: params.task_id };
          if (params.action === "move" || params.action === "complete") {
            payload.lane = params.action === "complete" ? "done" : params.lane;
          }
          if (params.progress !== undefined) payload.progress = params.progress;
          if (params.reason) payload.reason = params.reason;

          const reply = await client.pushChannelAsync(event, { payload });
          return text(
            `Task ${params.task_id}: ${params.action} → ${JSON.stringify(reply).slice(0, 300)}`,
          );
        } catch (err) {
          return text(`Task update failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },
  ];
}

// ── Formatters ───────────────────────────────────────────────

function formatKanban(data: Record<string, unknown>): string {
  const level = (data.level as string) || "unknown";
  const lines: string[] = [`Kanban (${level}):`];

  if (level === "agent") {
    const tasks = (data.tasks as any[]) || [];
    const next = data.next as Record<string, unknown> | null;

    if (next) {
      lines.push(`\n▶ NEXT: [${next.task_id}] ${next.title} (${next.priority})`);
      if (next.description) lines.push(`  ${(next.description as string).slice(0, 200)}`);
    }

    if (tasks.length === 0) {
      lines.push("No tasks in your queue.");
    } else {
      const byLane: Record<string, any[]> = {};
      for (const t of tasks) {
        (byLane[t.lane || "unknown"] ??= []).push(t);
      }
      for (const [lane, lt] of Object.entries(byLane)) {
        lines.push(`\n${lane.toUpperCase()} (${lt.length}):`);
        for (const t of lt.slice(0, 5)) {
          const pct = t.progress ? ` (${t.progress}%)` : "";
          lines.push(`  • [${t.task_id}] ${t.title} — ${t.priority}${pct}`);
        }
      }
    }
  } else {
    const board = (data.board as Record<string, any>) || {};
    const stats = data.stats as Record<string, unknown>;
    if (stats && Object.keys(stats).length) lines.push(`Stats: ${JSON.stringify(stats)}`);

    for (const [lane, ld] of Object.entries(board)) {
      const count = ld?.count || 0;
      const tasks = ld?.tasks || [];
      lines.push(`\n${lane.toUpperCase()} (${count}):`);
      for (const t of tasks.slice(0, 5)) {
        const who = t.assigned_to ? ` → ${t.assigned_to}` : " [unassigned]";
        lines.push(`  • [${t.task_id}] ${t.title} — ${t.priority}${who}`);
      }
      if (count > 5) lines.push(`  ... +${count - 5} more`);
    }
  }

  return lines.join("\n");
}
