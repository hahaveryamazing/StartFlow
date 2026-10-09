import { call } from './api';
import type {
  AIStatus,
  AISettings,
  AIRequest,
  AIPreview,
  AIDraft,
  AIConfiguration,
} from '../types/ai';
export const ai = {
  status: () => call<AIStatus>('v3_ai_status'),
  settings: (settings: AISettings) => call<void>('v3_ai_save_settings', { settings }),
  key: (key: string) => call<void>('v3_ai_set_key', { key }),
  deleteKey: () => call<void>('v3_ai_delete_key'),
  preview: (request: AIRequest) => call<AIPreview>('v3_ai_preview', { request }),
  generate: (token: string) => call<AIDraft>('v3_ai_generate', { token }),
  commit: (configuration: AIConfiguration) => call<void>('v3_ai_commit', { configuration }),
  remove: (draftId: string) => call<void>('v3_ai_delete_draft', { draftId }),
};
