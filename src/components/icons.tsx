import { useMemo, type ReactElement, type SVGProps } from 'react';
import { useSettings } from '../model/settings';
import type { DesignFamily } from '../model/themes';

/* Every app icon goes through here so a design family can restyle them.
   Material Google uses Material Symbols; the default design keeps Lucide. */
const LUCIDE = { AlertTriangle, Archive, ArchiveRestore, ArrowDown, ArrowUp, ArrowUpRight, Check, ChevronDown, ChevronRight, ChevronUp, Clock3, Cloud, Copy, CornerDownLeft, Download, FileCode2, FileDiff, FileMinus2, FilePenLine, FilePlus2, FileSymlink, Folder, FolderGit2, FolderOpen, GitBranch, GitBranchPlus, GitCommitHorizontal, GitMerge, Globe2, Info, KeyRound, Laptop, Loader2, LocateFixed, Lock, LockKeyhole, Minus, Monitor, Palette, Pencil, Plus, RefreshCw, RotateCcw, RotateCw, ScrollText, Search, Server, Settings, ShieldCheck, Sparkles, Square, SquareTerminal, Tag, Trash2, Undo2, Upload, User, UserRound, X, ZoomIn, ZoomOut };
const SYMBOLS: Record<keyof typeof LUCIDE, string> = {
  AlertTriangle: 'warning', Archive: 'archive', ArchiveRestore: 'unarchive', ArrowDown: 'arrow_downward', ArrowUp: 'arrow_upward', ArrowUpRight: 'arrow_outward', Check: 'check',
  ChevronDown: 'keyboard_arrow_down', ChevronRight: 'chevron_right', ChevronUp: 'keyboard_arrow_up', Clock3: 'history', Cloud: 'cloud', Copy: 'content_copy', CornerDownLeft: 'subdirectory_arrow_left',
  Download: 'download', FileCode2: 'code_blocks', FileDiff: 'difference', FileMinus2: 'note_stack', FilePenLine: 'edit_note', FilePlus2: 'note_add', FileSymlink: 'link',
  Folder: 'folder', FolderGit2: 'folder_managed', FolderOpen: 'folder_open', GitBranch: 'fork_right', GitBranchPlus: 'add_road', GitCommitHorizontal: 'commit', GitMerge: 'merge',
  Globe2: 'public', Info: 'info', KeyRound: 'key', Laptop: 'computer', Loader2: 'progress_activity', LocateFixed: 'my_location', Lock: 'lock', LockKeyhole: 'lock',
  Minus: 'remove', Monitor: 'desktop_windows', Palette: 'palette', Pencil: 'edit', Plus: 'add', RefreshCw: 'refresh', RotateCcw: 'undo', RotateCw: 'redo', ScrollText: 'receipt_long',
  Search: 'search', Server: 'dns', Settings: 'settings', ShieldCheck: 'verified_user', Sparkles: 'magic_button', Square: 'crop_square', SquareTerminal: 'terminal', Tag: 'sell',
  Trash2: 'delete', Undo2: 'undo', Upload: 'upload', User: 'person', UserRound: 'person', X: 'close', ZoomIn: 'zoom_in', ZoomOut: 'zoom_out',
};
export type IconProps = SVGProps<SVGSVGElement> & { size?: string | number };
const cached = new Map<string, (props: IconProps) => ReactElement>();
function make(name: keyof typeof LUCIDE, design: DesignFamily) {
  const key = `${design}:${name}`;
  let Icon = cached.get(key);
  if (!Icon) {
    const Lucide = LUCIDE[name];
    Icon = (props: IconProps) => design === 'material'
      ? <span {...(props as Record<string, unknown>)} aria-hidden="true" className={['material-symbol', props.className].filter(Boolean).join(' ')} style={{ fontSize: props.size, ...props.style }}>{SYMBOLS[name]}</span>
      : <Lucide {...props} />;
    cached.set(key, Icon);
  }
  return Icon;
}
/** Same props as the Lucide icon of the same name; the active design picks the glyph. */
export function useIcons() {
  const design = useSettings().theme.design ?? 'default';
  return useMemo(() => Object.fromEntries(Object.keys(LUCIDE).map(name => [name, make(name as keyof typeof LUCIDE, design)])) as Record<keyof typeof LUCIDE, (props: IconProps) => ReactElement>, [design]);
}
