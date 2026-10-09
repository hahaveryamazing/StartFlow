import { call } from './api';
import type {
  AutomationConfig,
  AutomationStatus,
  Context,
  Decision,
  EventKind,
  TrustedNetwork,
} from '../types/v3';
export const v3 = {
  snapshot: () => call<AutomationStatus>('v3_snapshot'),
  save: (config: AutomationConfig) => call<void>('v3_save', { config }),
  refresh: () => call<void>('v3_refresh'),
  simulate: (
    snapshot: Context,
    kind: EventKind,
    includeRuntimeGuards: boolean,
    stableSeconds: number,
    scheduleId: string | null = null,
  ) =>
    call<Decision[]>('v3_simulate', {
      simulation: {
        snapshot,
        kind,
        schedule_id: scheduleId,
        include_runtime_guards: includeRuntimeGuards,
        stable_seconds: stableSeconds,
      },
    }),
  confirm: (decisionId: string, accept: boolean) =>
    call<Decision[]>('v3_confirm', { decisionId, accept }),
  switchMode: (modeId: string, hold: string) =>
    call<{ execution_run_ids: string[]; errors: string[] }>('v3_switch_mode', { modeId, hold }),
  clearOverride: () => call<void>('v3_clear_override'),
  trustNetwork: (name: string, ssid: string) =>
    call<TrustedNetwork>('v3_trust_network', { name, ssid }),
  clearHistory: () => call<void>('v3_clear_history'),
  replay: (decisionId: string) => call<Decision[]>('v3_replay', { decisionId }),
};
