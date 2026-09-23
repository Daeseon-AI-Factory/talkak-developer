import { invoke, isTauri } from "@tauri-apps/api/core";

export interface BrokerAutostartStatus {
  supported: boolean;
  enabled: boolean;
  program: string | null;
}

export interface BrokerAutostartClient {
  available: () => boolean;
  status: () => Promise<BrokerAutostartStatus>;
  set: (enabled: boolean) => Promise<BrokerAutostartStatus>;
}

type InvokeCommand = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export function createBrokerAutostartClient(
  invokeCommand: InvokeCommand,
  available: () => boolean,
): BrokerAutostartClient {
  return {
    available,
    status: () => invokeCommand<BrokerAutostartStatus>("broker_autostart_status"),
    set: (enabled) => invokeCommand<BrokerAutostartStatus>("broker_autostart_set", { enabled }),
  };
}

export const brokerAutostartClient = createBrokerAutostartClient(invoke, isTauri);
