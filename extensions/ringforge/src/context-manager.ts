/**
 * Ringforge Context Manager — Agent awareness system
 *
 * Fetches structured context from the hub (kanban, role, squad, fleet,
 * artifacts, rules) and formats it for injection into the LLM prompt
 * via the before_agent_start hook.
 */

import type { RingforgeClient } from "./client.js";

// ── Types ────────────────────────────────────────────────────

export type AgentContext = {
  agent?: {
    agent_id: string;
    name: string;
    role: Record<string, unknown> | null;
    squad_id: string | null;
    capabilities: string[];
    tasks: {
      queue: TaskInfo[];
      count: number;
      in_progress: number;
      next: TaskInfo | null;
    };
    instructions: string;
  };
  squad?: {
    squad_id: string;
    members: { agent_id: string; name: string; state: string; role?: string }[];
    board: Record<string, { count: number; tasks: TaskInfo[] }>;
    stats: Record<string, number>;
    shared_memory: Record<string, unknown>[];
    instructions: string;
  };
  fleet?: {
    fleet_id: string;
    stats: Record<string, unknown>;
    velocity: Record<string, unknown>;
    lanes: Record<string, number>;
    urgent_unassigned: TaskInfo[];
    instructions: string;
  };
  artifacts?: {
    mine: ArtifactInfo[];
    recent: ArtifactInfo[];
    total: number;
  };
  rules?: {
    access_rules: RuleInfo[];
    rate_limits: RuleInfo[];
    transforms: RuleInfo[];
    instructions: string;
  };
  notifications?: {
    unread_count: number;
    recent: Record<string, unknown>[];
  };
  timestamp?: string;
  fleet_id?: string;
};

type TaskInfo = {
  task_id: string;
  title: string;
  description?: string;
  lane: string;
  priority: string;
  assigned_to?: string;
  squad_id?: string;
  tags?: string[];
  depends_on?: string[];
  blocked_by?: string[];
  context_refs?: string[];
  progress?: number;
};

type ArtifactInfo = {
  artifact_id: string;
  name: string;
  type: string;
  version: number;
  status: string;
  created_by: string;
  context_refs?: string[];
};

type RuleInfo = {
  id: string;
  type: string;
  condition: Record<string, unknown>;
  note?: string;
};

export type ContextManagerConfig = {
  /** How often to refresh context (ms). Default: 5 min */
  refreshIntervalMs: number;
  /** Inject context into agent prompts. Default: true */
  injectContext: boolean;
  /** Max context size (chars). Default: 4000 */
  maxContextChars: number;
  /** Sections to include. Default: all */
  include: "all" | "agent" | "squad" | "fleet";
};

const DEFAULT_CONFIG: ContextManagerConfig = {
  refreshIntervalMs: 5 * 60 * 1000,
  injectContext: true,
  maxContextChars: 4000,
  include: "all",
};

// ── Manager ──────────────────────────────────────────────────

export class ContextManager {
  private client: RingforgeClient;
  private config: ContextManagerConfig;
  private context: AgentContext | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private lastRefreshAt = 0;
  private fetchInProgress = false;

  constructor(client: RingforgeClient, config?: Partial<ContextManagerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.client = client;
  }

  /** Start periodic context refresh. */
  async start(): Promise<void> {
    // Initial fetch with retry
    await this.refreshWithRetry(2);

    if (this.config.refreshIntervalMs > 0) {
      this.refreshTimer = setInterval(() => this.refresh(), this.config.refreshIntervalMs);
    }
  }

  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.context = null;
    this.fetchInProgress = false;
  }

  /** Fetch fresh context from the hub. */
  async refresh(): Promise<void> {
    if (!this.client.isConnected || this.fetchInProgress) return;
    this.fetchInProgress = true;

    try {
      const response = await this.client.pushChannelAsync(
        "context:sync",
        { payload: { include: this.config.include } },
        15_000,
      );

      // Context may be nested: response.payload.context or response.context
      const ctx = (response as any)?.context || (response as any)?.payload?.context || response;

      if (ctx && typeof ctx === "object") {
        this.context = ctx as AgentContext;
        this.lastRefreshAt = Date.now();
      }
    } catch {
      // Keep stale context on failure
    } finally {
      this.fetchInProgress = false;
    }
  }

  /** Refresh with retries. */
  private async refreshWithRetry(retries: number): Promise<void> {
    for (let i = 0; i <= retries; i++) {
      await this.refresh();
      if (this.context) return;
      if (i < retries) await new Promise((r) => setTimeout(r, 2000));
    }
  }

  getContext(): AgentContext | null {
    return this.context;
  }

  isStale(): boolean {
    if (!this.context) return true;
    return Date.now() - this.lastRefreshAt > this.config.refreshIntervalMs * 2;
  }

  /**
   * Build the context string for injection into the LLM prompt.
   * Called from the before_agent_start hook.
   */
  buildPromptContext(): string | null {
    if (!this.config.injectContext || !this.context) return null;

    const parts: string[] = ["═══ RINGFORGE CONTEXT ═══"];

    // ── Agent section ──
    const a = this.context.agent;
    if (a) {
      parts.push("\n── YOUR STATUS ──");
      parts.push(`Agent: ${a.name} (${a.agent_id})`);

      if (a.role) {
        const rname = (a.role as any).name || (a.role as any).slug || "assigned";
        parts.push(`Role: ${rname}`);
      }
      if (a.squad_id) parts.push(`Squad: ${a.squad_id}`);
      if (a.capabilities?.length) parts.push(`Capabilities: ${a.capabilities.join(", ")}`);

      const t = a.tasks;
      if (t.count > 0) {
        parts.push(`\nTasks: ${t.count} total, ${t.in_progress} in progress`);

        if (t.next) {
          parts.push(`▶ NEXT: [${t.next.task_id}] ${t.next.title} (${t.next.priority})`);
          if (t.next.description) parts.push(`  ${t.next.description.slice(0, 200)}`);
        }

        const active = t.queue.filter((tk) => tk.lane === "in_progress");
        if (active.length > 0) {
          parts.push("Active:");
          for (const tk of active.slice(0, 5)) {
            const pct = tk.progress ? ` (${tk.progress}%)` : "";
            parts.push(`  • [${tk.task_id}] ${tk.title} — ${tk.priority}${pct}`);
            if (tk.context_refs?.length) parts.push(`    refs: ${tk.context_refs.join(", ")}`);
          }
        }

        const ready = t.queue.filter((tk) => tk.lane === "ready");
        if (ready.length > 0) {
          parts.push("Ready to pick up:");
          for (const tk of ready.slice(0, 3)) {
            parts.push(`  • [${tk.task_id}] ${tk.title} — ${tk.priority}`);
          }
        }

        const blocked = t.queue.filter((tk) => tk.lane === "blocked");
        if (blocked.length > 0) {
          parts.push("⚠ Blocked:");
          for (const tk of blocked.slice(0, 3)) {
            const by = tk.blocked_by?.join(", ") || "unknown";
            parts.push(`  • [${tk.task_id}] ${tk.title} — blocked by: ${by}`);
          }
        }
      } else {
        parts.push("\nNo tasks assigned. Check squad/fleet boards or ask for work.");
      }

      if (a.instructions) parts.push(`\n${a.instructions}`);
    }

    // ── Squad section ──
    const s = this.context.squad;
    if (s) {
      parts.push(`\n── SQUAD: ${s.squad_id} ──`);
      const st = s.stats;
      parts.push(
        `Tasks: ${st.total_tasks} total | ${st.in_progress} active | ${st.blocked} blocked | ${st.review} review`,
      );

      if (st.blocked > 0) {
        const blockedTasks = Object.values(s.board || {})
          .flatMap((lane) => lane.tasks || [])
          .filter((t: any) => t.lane === "blocked");
        if (blockedTasks.length > 0) {
          parts.push("⚠ Squad blocked:");
          for (const t of blockedTasks.slice(0, 3)) {
            parts.push(`  • [${(t as TaskInfo).task_id}] ${(t as TaskInfo).title}`);
          }
        }
      }

      const online = s.members.filter((m) => m.state === "online");
      if (online.length > 0) {
        parts.push(
          `Team: ${online.map((m) => `${m.name}${m.role ? ` (${m.role})` : ""}`).join(", ")}`,
        );
      }

      if (s.instructions) parts.push(s.instructions);
    }

    // ── Fleet section ──
    const f = this.context.fleet;
    if (f) {
      parts.push("\n── FLEET ──");
      const total = Object.values(f.lanes || {}).reduce((a, b) => a + b, 0);
      parts.push(`Board: ${total} tasks across ${Object.keys(f.lanes || {}).length} lanes`);

      if (f.urgent_unassigned?.length > 0) {
        parts.push("🔴 Urgent unassigned:");
        for (const t of f.urgent_unassigned.slice(0, 3)) {
          parts.push(`  • [${t.task_id}] ${t.title} (${t.priority})`);
        }
      }

      if (f.instructions) parts.push(f.instructions);
    }

    // ── Artifacts ──
    const art = this.context.artifacts;
    if (art && (art.mine?.length || art.recent?.length)) {
      parts.push("\n── ARTIFACTS ──");
      if (art.mine?.length) {
        parts.push(
          `Your artifacts: ${art.mine.map((a) => `${a.name} v${a.version} (${a.status})`).join(", ")}`,
        );
      }
      if (art.recent?.length) {
        parts.push(
          `Recent fleet: ${art.recent.map((a) => `${a.name} by ${a.created_by}`).join(", ")}`,
        );
      }
    }

    // ── Rules ──
    if (this.context.rules?.instructions) {
      parts.push("\n── RULES ──");
      parts.push(this.context.rules.instructions);
    }

    // ── Notifications ──
    const notif = this.context.notifications;
    if (notif && notif.unread_count > 0) {
      parts.push(`\n📬 ${notif.unread_count} unread notification(s)`);
    }

    parts.push("\n═══════════════════════");

    let result = parts.join("\n");

    if (result.length > this.config.maxContextChars) {
      result = result.slice(0, this.config.maxContextChars - 25) + "\n... [context truncated]";
    }

    return result;
  }
}
