import type { PreviewRow } from '../preview';
import type { SyntaxSource } from './syntax';

export interface PanelView {
  revision: number;
  name: string;
  path: string;
  baseRef: string;
  mergeBase: string;
  branch: string;
  dirty: boolean;
  index: number;
  count: number;
  line: number;
  added: number;
  removed: number;
  rows: PreviewRow[];
  syntax?: SyntaxSource;
  canUndo: boolean;
  reason?: string;
}

export type PanelAction = 'ready' | 'previous' | 'next' | 'revert' | 'undo' | 'copy' | 'openFile' | 'openDiff' | 'refresh';
export interface PanelMessage { action: PanelAction; revision?: number }
