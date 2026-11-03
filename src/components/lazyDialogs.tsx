import { lazy, Suspense, type ComponentProps, type ComponentType, type ReactNode } from 'react';

/** Dialogs and secondary views load on first use so the first repository paint
 * doesn't pay for them. `preloadLazyDialogs` warms the chunks once the app is idle. */
const loaders: Array<() => Promise<unknown>> = [];

function lazyView<C extends ComponentType<any>>(load: () => Promise<{ default: C }>, fallback: ReactNode = null) {
  loaders.push(load);
  const Lazy = lazy(load);
  return (props: ComponentProps<C>) => <Suspense fallback={fallback}><Lazy {...props} /></Suspense>;
}

export const OperationDialog = lazyView(() => import('./OperationDialog').then(m => ({ default: m.OperationDialog })));
export const ActivityLogDialog = lazyView(() => import('./ActivityLogDialog').then(m => ({ default: m.ActivityLogDialog })));
export const ConflictEditor = lazyView(() => import('./ConflictEditor').then(m => ({ default: m.ConflictEditor })));
export const PullRequestDialog = lazyView(() => import('./PullRequestDialog').then(m => ({ default: m.PullRequestDialog })));
export const RemoteStashDialog = lazyView(() => import('./RemoteStashDialog').then(m => ({ default: m.RemoteStashDialog })));
export const BranchDeleteDialog = lazyView(() => import('./BranchDeleteDialog').then(m => ({ default: m.BranchDeleteDialog })));
export const BranchFolderDeleteDialog = lazyView(() => import('./BranchFolderDeleteDialog').then(m => ({ default: m.BranchFolderDeleteDialog })));
export const OriginResetDialog = lazyView(() => import('./OriginResetDialog').then(m => ({ default: m.OriginResetDialog })));
export const CommandPalette = lazyView(() => import('./CommandPalette').then(m => ({ default: m.CommandPalette })));
export const SettingsDialog = lazyView(() => import('./Settings').then(m => ({ default: m.SettingsDialog })));
export const RepositoryBrowser = lazyView(() => import('./RepositoryBrowser').then(m => ({ default: m.RepositoryBrowser })), <p className="muted" role="status">Loading repositories…</p>);

export function preloadLazyDialogs() {
  for (const load of loaders) void load().catch(() => {});
}
