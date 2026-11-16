import type { ReactElement, SVGProps } from 'react';
import { AlertTriangle, Archive, ArchiveRestore, ArrowDown, ArrowUp, ArrowUpRight, Check, ChevronDown, ChevronRight, ChevronUp, Clock3, Cloud, Copy, CornerDownLeft, Download, FileCode2, FileDiff, FileMinus2, FilePenLine, FilePlus2, FileSymlink, Folder, FolderGit2, FolderOpen, GitBranch, GitBranchPlus, GitCommitHorizontal, GitMerge, Globe2, Info, KeyRound, Laptop, Loader2, LocateFixed, Lock, LockKeyhole, Minus, Monitor, Palette, PanelLeft as PanelStart, PanelRight as PanelEnd, Pencil, Plus, RefreshCw, RotateCcw, RotateCw, ScrollText, Search, Server, Settings, ShieldCheck, Sparkles, Square, SquareTerminal, Tag, Trash2, Undo2, Upload, User, UserRound, X, ZoomIn, ZoomOut } from 'lucide-react';

/* Every app icon goes through here so a design family can restyle them. The
   Material design uses animated Material-style glyphs, the Apple design uses the
   reference's own 1.6px symbol set, and the default keeps Lucide (unchanged
   unless `animated` is passed).

   Animation is pure CSS (material.css): parts marked with a class move when the
   icon's button, summary, row or tab is hovered or focused. */
type Part = string;
/** Inner SVG of a 24x24, 1.9px rounded stroke icon. Mark moving parts with classes. */
const PARTS: Record<string, Part> = {
  search: '<g class="ai-lens"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></g>',
  plus: '<path class="ai-grow" d="M12 5v14M5 12h14"/>',
  minus: '<path class="ai-grow" d="M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path class="ai-draw" pathLength="24" d="m5 12.5 4.5 4.5L19 7.5"/>',
  up: '<g class="ai-arrow"><path d="M12 19V6"/><path d="M6.5 11.5 12 6l5.5 5.5"/></g>',
  down: '<g class="ai-arrow"><path d="M12 5v13"/><path d="M6.5 12.5 12 18l5.5-5.5"/></g>',
  chevronDown: '<path class="ai-caret" d="m6 9 6 6 6-6"/>',
  chevronUp: '<path class="ai-caret" d="m6 15 6-6 6 6"/>',
  chevronRight: '<path class="ai-tilt" d="m9 6 6 6-6 6"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path class="ai-spin" d="M12 3.5c2.6 2.4 4 5.3 4 8.5s-1.4 6.1-4 8.5c-2.6-2.4-4-5.3-4-8.5s1.4-6.1 4-8.5z"/><path d="M3.5 12h17"/>',
  folder: '<g class="ai-bounce"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></g>',
  folderOpen: '<g class="ai-bounce"><path d="M3 8V6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v2"/><path d="M3 8h18l-2 9a2 2 0 0 1-2 1.7H6.5A2 2 0 0 1 4.6 17z"/></g>',
  repo: '<g class="ai-bounce"><rect x="3" y="4" width="8" height="6" rx="1.8"/><rect x="13" y="14" width="8" height="6" rx="1.8"/><path d="M7 10v7h6"/></g>',
  branch: '<circle cx="6" cy="5" r="2.2"/><circle cx="6" cy="19" r="2.2"/><circle class="ai-node" cx="18" cy="8" r="2.2"/><path d="M6 7.2v9.6"/><path class="ai-draw" pathLength="24" d="M18 10.2c0 5-6 4-12 7"/>',
  branchPlus: '<circle cx="6" cy="5" r="2.2"/><circle cx="6" cy="19" r="2.2"/><path d="M6 7.2v9.6"/><path class="ai-draw" pathLength="24" d="M15 8c0 4-4 4-9 7"/><g class="ai-grow"><path d="M18 3v6M15 6h6"/></g>',
  commit: '<path d="M2.5 12H8M16 12h5.5"/><circle class="ai-drop" cx="12" cy="12" r="4"/>',
  merge: '<g class="ai-bounce"><circle cx="6" cy="5" r="2.2"/><circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="12" r="2.2"/><path d="M6 7.2v9.6"/><path class="ai-draw" pathLength="24" d="M6 11c0-4 6-3 9.8 0"/></g>',
  settings: '<g class="ai-turn"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7"/><path d="M12 2.5V5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3 7 7M17 17l1.7 1.7M18.7 5.3 17 7M7 17l-1.7 1.7"/></g>',
  refresh: '<g class="ai-turn"><path d="M20 11a8 8 0 0 0-14.3-4.2L4 9"/><path d="M4 5v4h4"/><path d="M4 13a8 8 0 0 0 14.3 4.2L20 15"/><path d="M20 19v-4h-4"/></g>',
  loader: '<g class="ai-spin"><path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5"/></g>',
  upload: '<g class="ai-lift"><path d="M12 16V4"/><path d="M7 9l5-5 5 5"/></g><path d="M4 20h16"/>',
  download: '<g class="ai-drop-in"><path d="M12 4v12"/><path d="M7 11l5 5 5-5"/></g><path d="M4 20h16"/>',
  archive: '<path d="M4 9h16v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path class="ai-lid" d="M3 5h18v3H3z"/><path d="M10 13h4"/>',
  unarchive: '<path d="M4 9h16v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path class="ai-lid" d="M3 5h18v3H3z"/><g class="ai-lift"><path d="M12 17v-5"/><path d="m9.5 14 2.5-2.5 2.5 2.5"/></g>',
  trash: '<g class="ai-bounce"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/><path d="M10.5 11v5M13.5 11v5"/></g>',
  copy: '<g class="ai-bounce"><rect x="9" y="9" width="11" height="11" rx="3"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/></g>',
  tag: '<g class="ai-tilt"><path d="M3 12V4h8l9.5 9.5a2 2 0 0 1 0 2.8l-4.7 4.7a2 2 0 0 1-2.8 0z"/><circle cx="7.5" cy="8.5" r="1.3"/></g>',
  cloud: '<g class="ai-bounce"><path d="M7 18h10a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7 9.2 4.4 4.4 0 0 0 7 18z"/></g>',
  laptop: '<g class="ai-bounce"><rect x="5" y="5" width="14" height="10" rx="2"/><path d="M3 19h18"/></g>',
  monitor: '<g class="ai-bounce"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M9 20h6M12 16v4"/></g>',
  user: '<g class="ai-bounce"><circle cx="12" cy="8" r="3.6"/><path d="M4.5 20c0-4.1 3.4-7 7.5-7s7.5 2.9 7.5 7"/></g>',
  people: '<g class="ai-bounce"><circle cx="9" cy="8" r="3"/><path d="M3 19c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.4"/><path d="M17 14c2.5 0 4 1.8 4 4.5"/></g>',
  key: '<g class="ai-tilt"><circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l2.5 2.5M14 9l2 2"/></g>',
  lock: '<g class="ai-bounce"><rect x="5" y="10" width="14" height="10" rx="2.5"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10"/></g>',
  shield: '<g class="ai-bounce"><path d="M12 3l7.5 3v5.5c0 4.6-3.2 8-7.5 9.5-4.3-1.5-7.5-4.9-7.5-9.5V6z"/><path class="ai-draw" pathLength="24" d="m8.5 12 2.5 2.5 4.5-5"/></g>',
  sparkle: '<path class="ai-pulse" d="M11 3l1.8 5.2L18 10l-5.2 1.8L11 17l-1.8-5.2L4 10l5.2-1.8z"/><path class="ai-twinkle" d="M18.5 15l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
  palette: '<g class="ai-tilt"><path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.4 0 2-1 2-2 0-1.6-1.4-1.9-1.4-3.2 0-1 .8-1.8 1.9-1.8h2A4 4 0 0 0 20.5 9.5C19 5.7 15.8 3.5 12 3.5z"/><circle cx="7.5" cy="10" r="1.1"/><circle cx="10.5" cy="6.8" r="1.1"/><circle cx="15" cy="7.2" r="1.1"/></g>',
  pencil: '<g class="ai-write"><path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M14 7l3 3"/></g>',
  info: '<g class="ai-bounce"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/></g>',
  warning: '<g class="ai-bounce"><path d="M10.3 4.2 2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z"/><path d="M12 9.5V14M12 17h.01"/></g>',
  panelLeft: '<g class="ai-bounce"><rect x="3" y="4" width="18" height="16" rx="4"/><path d="M9 4v16"/></g>',
  panelRight: '<g class="ai-bounce"><rect x="3" y="4" width="18" height="16" rx="4"/><path d="M15 4v16"/></g>',
  terminal: '<g class="ai-bounce"><rect x="3" y="4" width="18" height="16" rx="4"/><path d="m7.5 10 3 2.5-3 2.5"/><path class="ai-cursor" d="M13 15h3.5"/></g>',
  history: '<g class="ai-bounce"><circle cx="12" cy="12" r="8.5"/><path class="ai-clock" d="M12 7.5V12l3 2"/></g>',
  receipt: '<g class="ai-bounce"><path d="M6 3h12v18l-2.4-1.6L13.2 21l-2.4-1.6L8.4 21 6 19.4z"/><path d="M9 8h6M9 12h6M9 16h3"/></g>',
  fileCode: '<g class="ai-bounce"><path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10z"/><path d="M13 3v7h7"/><path class="ai-pulse" d="m10 13-2 2.5 2 2.5M14 13l2 2.5-2 2.5"/></g>',
  fileDiff: '<g class="ai-bounce"><path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10z"/><path d="M13 3v7h7"/><path d="M12 12v5M9.5 14.5h5"/><path d="M9.5 19h5"/></g>',
  note: '<g class="ai-bounce"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-3.5L5 21V4a1 1 0 0 1 1-1z"/></g>',
  notePlus: '<g class="ai-bounce"><path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4h4"/><g class="ai-grow"><path d="M12 11v5M9.5 13.5h5"/></g></g>',
  noteEdit: '<g class="ai-bounce"><path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4h4"/><g class="ai-write"><path d="M9 13l3.5 3.5 3-3"/></g></g>',
  link: '<g class="ai-tilt"><path d="M10 14a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7L11 7.3"/><path d="M14 10a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 0 0 5.7 5.7l1.6-1.6"/></g>',
  undo: '<g class="ai-swing"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></g>',
  redo: '<g class="ai-swing-l"><path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/></g>',
  target: '<g class="ai-bounce"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></g>',
  zoomIn: '<g class="ai-lens"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/><path class="ai-grow" d="M11 8v6M8 11h6"/></g>',
  zoomOut: '<g class="ai-lens"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/><path class="ai-grow" d="M8 11h6"/></g>',
  send: '<g class="ai-send"><path d="M20 12H4"/><path d="m10 6-6 6 6 6"/></g>',
  open: '<g class="ai-tilt"><path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></g>',
  square: '<g class="ai-pulse"><rect x="5" y="5" width="14" height="14" rx="2"/></g>',
  server: '<g class="ai-bounce"><rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/></g>',
};

/* Apple design family: the reference's own 24px symbol set, lifted verbatim
   where it has a glyph and redrawn in the same language (1.6 stroke, rounded,
   generous corner radii) where it does not. Kept separate from PARTS so the
   Material family's geometry and motion stay untouched. */
const APPLE_PARTS: Record<string, Part> = {
  // From the reference: 24px grid, 1.6 stroke, rounded.
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle class="b-node" cx="18" cy="8" r="2"/><path d="M6 7v10"/><path class="b-curve" pathLength="24" d="M18 10c0 5-6 4-12 7"/>',
  upload: '<g class="arrow"><path d="M12 17V5"/><path d="M6.5 10.5 12 5l5.5 5.5"/></g><path d="M5 21h14"/>',
  download: '<g class="arrow"><path d="M12 7v12"/><path d="M6.5 13.5 12 19l5.5-5.5"/></g><path d="M5 3h14"/>',
  check: '<path class="chk" pathLength="24" d="m5 12.5 4.5 4.5L19 7.5"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronUp: '<path d="m6 15 6-6 6 6"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  search: '<g class="lens"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></g>',
  settings: '<g class="gear"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7"/><path d="M12 2.5V5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3 7 7M17 17l1.7 1.7M18.7 5.3 17 7M7 17l-1.7 1.7"/></g>',
  refresh: '<g class="rot"><path d="M20 11a8 8 0 0 0-14.3-4.2L4 9"/><path d="M4 5v4h4"/><path d="M4 13a8 8 0 0 0 14.3 4.2L20 15"/><path d="M20 19v-4h-4"/></g>',
  archive: '<path d="M4 9h16v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path class="lid" d="M3 5h18v3H3z"/><path d="M10 13h4"/>',
  unarchive: '<path d="M4 9h16v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path class="lid" d="M3 5h18v3H3z"/><g class="arrow"><path d="M12 14V4"/><path d="M8 8l4-4 4 4"/></g>',
  trash: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
  tag: '<path d="M3 12V4h8l9.5 9.5a2 2 0 0 1 0 2.8l-4.7 4.7a2 2 0 0 1-2.8 0z"/><circle cx="7.5" cy="8.5" r="1.2"/>',
  cloud: '<path d="M7 18h10a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7 9.2 4.4 4.4 0 0 0 7 18z"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  repo: '<rect x="3" y="4" width="8" height="6" rx="1.5"/><rect x="13" y="14" width="8" height="6" rx="1.5"/><path d="M7 10v7h6"/>',
  commit: '<path d="M2.5 12H8M16 12h5.5"/><circle class="dot" cx="12" cy="12" r="4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  sparkle: '<path class="sp" d="M11 3l1.8 5.2L18 10l-5.2 1.8L11 17l-1.8-5.2L4 10l5.2-1.8z"/><path d="M18.5 15l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
  pencil: '<path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M14 7l3 3"/>',
  panelLeft: '<rect x="3" y="4" width="18" height="16" rx="3.5"/><path d="M9 4v16"/>',
  panelRight: '<rect x="3" y="4" width="18" height="16" rx="3.5"/><path d="M15 4v16"/>',
  history: '<circle cx="12" cy="12" r="8.5"/><path class="hand" d="M12 7.5V12l3 2"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="3.5"/><path d="m7.5 10 3 2.5-3 2.5"/><path class="cursor" d="M13 15h3.5"/>',
  people: '<circle cx="9" cy="8" r="3"/><path d="M3 19c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.4"/><path d="M17 14c2.5 0 4 1.8 4 4.5"/>',
  merge: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="12" r="2"/><path d="M6 7v10"/><path class="b-curve" pathLength="24" d="M6 11c0-4 6-3 9.8 0"/>',
  branchPlus: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10"/><path class="b-curve" pathLength="24" d="M15 8c0 4-4 4-9 7"/><g class="plus"><path d="M18 3v6M15 6h6"/></g>',
  folderOpen: '<path d="M3 8V6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v2"/><path d="M3 8h18l-2 9a2 2 0 0 1-2 1.7H6.5A2 2 0 0 1 4.6 17z"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path class="rot" d="M12 3.5c2.6 2.4 4 5.3 4 8.5s-1.4 6.1-4 8.5c-2.6-2.4-4-5.3-4-8.5s1.4-6.1 4-8.5z"/><path d="M3.5 12h17"/>',
  user: '<circle cx="12" cy="8" r="3.4"/><path d="M4.8 20c0-4 3.2-6.8 7.2-6.8s7.2 2.8 7.2 6.8"/>',
  laptop: '<rect x="5" y="5" width="14" height="10" rx="2"/><path d="M3 19h18"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M9 20h6M12 16v4"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l2.5 2.5M14 9l2 2"/>',
  lock: '<rect x="5" y="10" width="14" height="10" rx="2.5"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10"/>',
  shield: '<path d="M12 3l7.5 3v5.5c0 4.6-3.2 8-7.5 9.5-4.3-1.5-7.5-4.9-7.5-9.5V6z"/><path class="chk" pathLength="24" d="m8.5 12 2.5 2.5 4.5-5"/>',
  palette: '<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.4 0 2-1 2-2 0-1.6-1.4-1.9-1.4-3.2 0-1 .8-1.8 1.9-1.8h2A4 4 0 0 0 20.5 9.5C19 5.7 15.8 3.5 12 3.5z"/><circle cx="7.5" cy="10" r="1.1"/><circle cx="10.5" cy="6.8" r="1.1"/><circle cx="15" cy="7.2" r="1.1"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>',
  warning: '<path d="M10.3 4.2 2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z"/><path d="M12 9.5V14M12 17h.01"/>',
  receipt: '<path d="M6 3h12v18l-2.4-1.6L13.2 21l-2.4-1.6L8.4 21 6 19.4z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  fileCode: '<path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10z"/><path d="M13 3v7h7"/><path d="m10 13-2 2.5 2 2.5M14 13l2 2.5-2 2.5"/>',
  fileDiff: '<path d="M13 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10z"/><path d="M13 3v7h7"/><path d="M12 12v5M9.5 14.5h5"/><path d="M9.5 19h5"/>',
  note: '<path d="M6 3h12a1 1 0 0 1 1 1v17l-7-3.5L5 21V4a1 1 0 0 1 1-1z"/>',
  notePlus: '<path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4h4"/><path d="M12 11v5M9.5 13.5h5"/>',
  noteEdit: '<path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4h4"/><path d="m9 13 3.5 3.5 3-3"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7L11 7.3"/><path d="M14 10a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 0 0 5.7 5.7l1.6-1.6"/>',
  undo: '<g class="swing"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></g>',
  redo: '<g class="swing"><path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/></g>',
  target: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  zoomIn: '<g class="lens"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></g><path d="M11 8v6M8 11h6"/>',
  zoomOut: '<g class="lens"><circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/></g><path d="M8 11h6"/>',
  send: '<path d="M20 12H4"/><path d="m10 6-6 6 6 6"/>',
  open: '<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  square: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  server: '<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/>',
  loader: '<circle cx="12" cy="12" r="8.5" opacity=".22"/><path class="spin" d="M12 3.5a8.5 8.5 0 0 1 8.5 8.5"/>',
};
/** Lucide name -> animated glyph. Names without an entry keep their Lucide icon. */
const MATERIAL: Partial<Record<keyof typeof LUCIDE, keyof typeof PARTS>> = {
  Search: 'search', Plus: 'plus', Minus: 'minus', X: 'x', Check: 'check',
  ArrowUp: 'up', ArrowDown: 'down', Upload: 'upload', Download: 'download',
  ChevronDown: 'chevronDown', ChevronUp: 'chevronUp', ChevronRight: 'chevronRight',
  Globe2: 'globe', Folder: 'folder', FolderOpen: 'folderOpen', FolderGit2: 'repo',
  GitBranch: 'branch', GitBranchPlus: 'branchPlus', GitCommitHorizontal: 'commit', GitMerge: 'merge',
  Settings: 'settings', RefreshCw: 'refresh', Loader2: 'loader', Archive: 'archive', ArchiveRestore: 'unarchive',
  Trash2: 'trash', Copy: 'copy', Tag: 'tag', Cloud: 'cloud', Laptop: 'laptop', Monitor: 'monitor',
  User: 'user', UserRound: 'people', KeyRound: 'key', Lock: 'lock', LockKeyhole: 'lock', ShieldCheck: 'shield',
  Sparkles: 'sparkle', Palette: 'palette', Pencil: 'pencil', Info: 'info', AlertTriangle: 'warning',
  PanelStart: 'panelLeft', PanelEnd: 'panelRight', SquareTerminal: 'terminal', Clock3: 'history',
  ScrollText: 'receipt', FileCode2: 'fileCode', FileDiff: 'fileDiff',
  FileMinus2: 'note', FilePlus2: 'notePlus', FilePenLine: 'noteEdit', FileSymlink: 'link',
  Undo2: 'undo', RotateCcw: 'undo', RotateCw: 'redo', LocateFixed: 'target',
  ZoomIn: 'zoomIn', ZoomOut: 'zoomOut', CornerDownLeft: 'send', ArrowUpRight: 'open',
  Square: 'square', Server: 'server',
};
const LUCIDE = { AlertTriangle, Archive, ArchiveRestore, ArrowDown, ArrowUp, ArrowUpRight, Check, ChevronDown, ChevronRight, ChevronUp, Clock3, Cloud, Copy, CornerDownLeft, Download, FileCode2, FileDiff, FileMinus2, FilePenLine, FilePlus2, FileSymlink, Folder, FolderGit2, FolderOpen, GitBranch, GitBranchPlus, GitCommitHorizontal, GitMerge, Globe2, Info, KeyRound, Laptop, Loader2, LocateFixed, Lock, LockKeyhole, Minus, Monitor, Palette, PanelStart, PanelEnd, Pencil, Plus, RefreshCw, RotateCcw, RotateCw, ScrollText, Search, Server, Settings, ShieldCheck, Sparkles, Square, SquareTerminal, Tag, Trash2, Undo2, Upload, User, UserRound, X, ZoomIn, ZoomOut };
/** Lucide name -> Apple glyph. Same coverage as MATERIAL; names without an entry keep their Lucide icon in every design. */
const APPLE_GLYPHS: Partial<Record<keyof typeof LUCIDE, keyof typeof APPLE_PARTS>> = MATERIAL;

export type IconProps = SVGProps<SVGSVGElement> & { size?: string | number };
/** Synced to `data-design` by the settings provider, so plain <Icons.X/> need no context. */
const design = (): string => document.documentElement.dataset.design ?? 'default';

function Animated({ parts, size = 16, ...props }: IconProps & { parts: Part }) {
  return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" className={`ai${props.className ? ` ${props.className}` : ''}`} {...props} aria-hidden="true" dangerouslySetInnerHTML={{ __html: parts }} />;
}
/** Same props as the Lucide icon of the same name. `animated` forces the Material glyph in any design (e.g. a one-off flourish). */
export function makeIcon(name: keyof typeof LUCIDE) {
  const Lucide = LUCIDE[name], glyph = MATERIAL[name];
  return (props: IconProps & { animated?: boolean }) => {
    if (glyph && (props.animated || design() === 'material')) { const { animated: _animated, ...rest } = props; return <Animated parts={PARTS[glyph]} {...rest} />; }
    const apple = APPLE_GLYPHS[name];
    if (apple && design() === 'apple') {
      // Keep the caller's class (and the lucide-* marker the sidebar hover animations target) beside the Apple glyph.
      const { animated: _animated, className, size = 16, ...rest } = props;
      return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className={`ai apple-glyph lucide lucide-${name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`).replace(/^-/, '')}${className ? ` ${className}` : ''}`} {...rest} aria-hidden="true" dangerouslySetInnerHTML={{ __html: APPLE_PARTS[apple] }} />;
    }
    return <Lucide {...props as object} />;
  };
}
/** Same props as the Lucide icon of the same name; the active design family picks the glyph. */
export const Icons = Object.fromEntries(Object.keys(LUCIDE).map(name => [name, makeIcon(name as keyof typeof LUCIDE)])) as Record<keyof typeof LUCIDE, (props: IconProps & { animated?: boolean }) => ReactElement>;
