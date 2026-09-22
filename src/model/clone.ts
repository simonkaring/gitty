import type { RepositoryLocation } from './repository';

export interface CloneRequest { source: string; parent: RepositoryLocation; directoryName: string }
export interface CloneProgress { phase: string; percent: number | null; message: string }

export type CloneOperation =
  | { status: 'idle' }
  | { status: 'running' | 'cancelling'; operationId: string; source: string; destinationName: string; progress: CloneProgress | null }
  | { status: 'error'; message: string };

export type CloneAction =
  | { type: 'start'; operationId: string; request: CloneRequest }
  | { type: 'progress'; operationId: string; progress: CloneProgress }
  | { type: 'cancel'; operationId: string }
  | { type: 'cancelRejected'; operationId: string }
  | { type: 'finish'; operationId: string }
  | { type: 'fail'; operationId: string; message: string }
  | { type: 'dismiss' };

export function cloneReducer(state: CloneOperation, action: CloneAction): CloneOperation {
  if (action.type === 'start') return { status: 'running', operationId: action.operationId, source: action.request.source, destinationName: action.request.directoryName, progress: null };
  if (action.type === 'dismiss') return { status: 'idle' };
  if (state.status === 'idle' || state.status === 'error' || state.operationId !== action.operationId) return state;
  if (action.type === 'progress') return { ...state, progress: action.progress };
  if (action.type === 'cancel') return { ...state, status: 'cancelling' };
  if (action.type === 'cancelRejected' && state.status === 'cancelling') return { ...state, status: 'running' };
  if (action.type === 'finish') return { status: 'idle' };
  if (action.type === 'fail') return { status: 'error', message: action.message };
  return state;
}

export function suggestedCloneName(source: string): string {
  const trimmed = source.trim().replace(/[\\/]+$/, '');
  const segment = trimmed.split(/[\\/:]/).filter(Boolean).at(-1) ?? '';
  return segment.replace(/\.git$/i, '') || 'repository';
}

/* Tauri commands:
 * repository_clone({operationId, request, onProgress: Channel<CloneProgress>}) -> RepositoryLocation
 * repository_cancel_clone({operationId}) -> void
 */
