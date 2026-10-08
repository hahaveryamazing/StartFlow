import { call } from './api';
import type {
  Workflow,
  Extension,
  WindowInventory,
  Bundle,
  BackupRecord,
  PaletteData,
  NodeLog,
} from '../types/v2';
export const v2 = {
  save: (extension: Extension) => call<void>('v2_save_extension', { extension }),
  validate: (workflow: Workflow) => call<void>('v2_validate_workflow', { workflow }),
  convert: (sceneId: string) => call<Workflow>('v2_convert_scene', { sceneId }),
  run: (workflowId: string) => call<string>('v2_run_workflow', { workflowId }),
  cancel: (runId: string) => call<void>('v2_cancel_run', { runId }),
  nodeLogs: (runId: string) => call<NodeLog[]>('v2_query_node_logs', { runId }),
  inventory: () => call<WindowInventory>('v2_window_inventory'),
  restoreLayout: (layoutId: string) => call<string>('v2_restore_layout', { layoutId }),
  backup: () => call<BackupRecord>('v2_create_backup'),
  deleteBackup: (backupId: string) => call<void>('v2_delete_backup', { backupId }),
  readBackup: (backupId: string) => call<Bundle>('v2_read_backup', { backupId }),
  readImport: (path: string) => call<Bundle>('v2_read_import', { path }),
  export: (path: string) => call<void>('v2_export', { path }),
  apply: (bundle: Bundle, mode: 'merge' | 'replace') =>
    call<void>('v2_apply_import', { bundle, mode }),
  chooseBackground: (path: string) => call<string>('v2_choose_background', { path }),
  background: (name: string) => call<string>('v2_read_background', { name }),
  palette: () => call<void>('v2_show_palette'),
  hidePalette: () => call<void>('v2_hide_palette'),
  paletteData: () => call<PaletteData>('v2_palette_data'),
  paletteAction: (action: string, target = '') =>
    call<void>('v2_palette_action', { action, target }),
};
