import type {
  ChannelId,
  OutboundMessage,
  OutboundResult,
  OutboundMiddleware,
} from "./middleware.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const logger = createSubsystemLogger("circuit-breaker");

enum CircuitState {
  CLOSED = "CLOSED",
  OPEN = "OPEN",
  HALF_OPEN = "HALF_OPEN",
}

export interface CircuitBreakerConfig {
  failureThreshold: number;
  resetTimeoutMs: number;
  windowMs: number;
}

interface FailureRecord {
  timestamp: number;
}

interface CircuitStatus {
  state: CircuitState;
  failures: FailureRecord[];
  lastFailureTime?: number;
  probeInFlight: boolean;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  resetTimeoutMs: 60000,
  windowMs: 120000,
};

class CircuitBreaker {
  private circuits: Map<ChannelId, CircuitStatus> = new Map();
  private config: CircuitBreakerConfig;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  private getCircuit(channel: ChannelId): CircuitStatus {
    if (!this.circuits.has(channel)) {
      this.circuits.set(channel, {
        state: CircuitState.CLOSED,
        failures: [],
        probeInFlight: false,
      });
    }
    return this.circuits.get(channel)!;
  }

  private cleanupOldFailures(circuit: CircuitStatus, now: number): void {
    const cutoff = now - this.config.windowMs;
    circuit.failures = circuit.failures.filter((f) => f.timestamp > cutoff);
  }

  private shouldOpenCircuit(circuit: CircuitStatus): boolean {
    return circuit.failures.length >= this.config.failureThreshold;
  }

  private shouldTransitionToHalfOpen(circuit: CircuitStatus, now: number): boolean {
    if (circuit.state !== CircuitState.OPEN) {
      return false;
    }
    if (!circuit.lastFailureTime) {
      return false;
    }
    return now - circuit.lastFailureTime >= this.config.resetTimeoutMs;
  }

  private recordFailure(channel: ChannelId, now: number): void {
    const circuit = this.getCircuit(channel);
    circuit.failures.push({ timestamp: now });
    circuit.lastFailureTime = now;
    this.cleanupOldFailures(circuit, now);

    if (circuit.state === CircuitState.CLOSED && this.shouldOpenCircuit(circuit)) {
      circuit.state = CircuitState.OPEN;
      logger.warn(`Circuit opened for channel ${channel} (${circuit.failures.length} failures)`);
    } else if (circuit.state === CircuitState.HALF_OPEN) {
      circuit.state = CircuitState.OPEN;
      circuit.probeInFlight = false;
      logger.warn(`Circuit re-opened for channel ${channel} after failed probe`);
    }
  }

  private recordSuccess(channel: ChannelId): void {
    const circuit = this.getCircuit(channel);

    if (circuit.state === CircuitState.HALF_OPEN) {
      circuit.state = CircuitState.CLOSED;
      circuit.failures = [];
      circuit.probeInFlight = false;
      logger.info(`Circuit closed for channel ${channel} after successful probe`);
    }
  }

  public getState(channel: ChannelId): CircuitState {
    const circuit = this.getCircuit(channel);
    const now = Date.now();

    if (this.shouldTransitionToHalfOpen(circuit, now)) {
      circuit.state = CircuitState.HALF_OPEN;
      logger.info(`Circuit transitioned to half-open for channel ${channel}`);
    }

    return circuit.state;
  }

  public async execute(
    message: OutboundMessage,
    next: (message: OutboundMessage) => Promise<OutboundResult>,
  ): Promise<OutboundResult> {
    const { channel } = message;
    const circuit = this.getCircuit(channel);
    const now = Date.now();
    const state = this.getState(channel);

    // Circuit is open - reject immediately
    if (state === CircuitState.OPEN) {
      logger.debug(`Circuit open for channel ${channel}, rejecting message to ${message.to}`);
      return {
        ok: false,
        status: "Circuit breaker open - service unavailable",
        deliveredAt: now,
      };
    }

    // Circuit is half-open - allow only one probe request
    if (state === CircuitState.HALF_OPEN) {
      if (circuit.probeInFlight) {
        logger.debug(
          `Probe already in flight for channel ${channel}, rejecting message to ${message.to}`,
        );
        return {
          ok: false,
          status: "Circuit breaker half-open - probe in progress",
          deliveredAt: now,
        };
      }
      circuit.probeInFlight = true;
      logger.debug(`Sending probe request for channel ${channel}`);
    }

    // Execute the request
    try {
      const result = await next(message);

      if (result.ok) {
        this.recordSuccess(channel);
      } else {
        this.recordFailure(channel, now);
      }

      return result;
    } catch (error) {
      this.recordFailure(channel, now);
      throw error;
    }
  }
}

export function createCircuitBreakerMiddleware(
  config: Partial<CircuitBreakerConfig> = {},
): OutboundMiddleware {
  const breaker = new CircuitBreaker(config);

  return async (message, next) => {
    return breaker.execute(message, next);
  };
}

export function getCircuitState(
  middleware: OutboundMiddleware,
  channel: ChannelId,
): CircuitState | null {
  // This is a bit of a hack to expose internal state for testing/monitoring
  // In production, you might want a more robust solution
  const breaker = (middleware as unknown as { __breaker?: CircuitBreaker }).__breaker;
  if (!breaker) {
    return null;
  }
  return breaker.getState(channel);
}

// Export a version that allows state inspection
export function createInspectableCircuitBreakerMiddleware(
  config: Partial<CircuitBreakerConfig> = {},
): { middleware: OutboundMiddleware; getState: (channel: ChannelId) => CircuitState } {
  const breaker = new CircuitBreaker(config);

  const middleware: OutboundMiddleware & { __breaker?: CircuitBreaker } = async (message, next) => {
    return breaker.execute(message, next);
  };

  middleware.__breaker = breaker;

  return {
    middleware,
    getState: (channel: ChannelId) => breaker.getState(channel),
  };
}
