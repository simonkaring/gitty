import type { ReactElement, SVGProps } from 'react';
import { AlertTriangle, Archive, ArchiveRestore, ArrowDown, ArrowUp, ArrowUpRight, Check, ChevronDown, ChevronRight, ChevronUp, Clock3, Cloud, Copy, CornerDownLeft, Download, FileCode2, FileDiff, FileMinus2, FilePenLine, FilePlus2, FileSymlink, Folder, FolderGit2, FolderOpen, GitBranch, GitBranchPlus, GitCommitHorizontal, GitMerge, Globe2, Info, KeyRound, Laptop, Loader2, LocateFixed, Lock, LockKeyhole, Minus, Monitor, Palette, PanelLeft as PanelStart, PanelRight as PanelEnd, Pencil, Plus, RefreshCw, RotateCcw, RotateCw, ScrollText, Search, Server, Settings, ShieldCheck, Sparkles, Square, SquareTerminal, Tag, Trash2, TreePine, Undo2, Upload, User, UserRound, X, ZoomIn, ZoomOut } from 'lucide-react';

/* Every app icon goes through here so a design family can restyle them. The
   Material design uses animated Material-style glyphs, the Apple design uses
   SF Symbols-style glyphs, and the default keeps Lucide (unchanged
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
  tree: '<g class="ai-tilt"><path d="M12 3 6.5 10H10l-4.5 6h13L14 10h3.5z"/></g><path d="M12 16v5"/>',
};

/* Apple design family: glyphs drawn after SF Symbols (regular weight, 24px
   grid, rounded caps and joins, filled dots). They are app-drawn lookalikes,
   not Apple's artwork, so they ship on every platform. Kept separate from PARTS
   so the Material family's geometry and motion stay untouched. */
const APPLE_PARTS: Record<string, Part> = {
  branch: '<circle cx="6.5" cy="5.5" r="2.2"/><circle cx="6.5" cy="18.5" r="2.2"/><circle class="b-node" cx="17.5" cy="8" r="2.2"/><path d="M6.5 7.7v8.6"/><path class="b-curve" pathLength="24" d="M17.5 10.2c0 4.6-5.5 4-11 6.1"/>',
  // arrow.up.circle / arrow.down.circle
  upload: '<circle cx="12" cy="12" r="9"/><g class="arrow"><path d="M12 16.5v-9"/><path d="m8 11.2 4-4 4 4"/></g>',
  download: '<circle cx="12" cy="12" r="9"/><g class="arrow"><path d="M12 7.5v9"/><path d="m8 12.8 4 4 4-4"/></g>',
  check: '<path class="chk" pathLength="24" d="m5 12.8 4.4 4.4L19 6.8"/>',
  chevronDown: '<path d="m6.5 9.5 5.5 5.5 5.5-5.5"/>',
  chevronUp: '<path d="m6.5 14.5 5.5-5.5 5.5 5.5"/>',
  chevronRight: '<path d="m9.5 6.5 5.5 5.5-5.5 5.5"/>',
  search: '<g class="lens"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.3 15.3 5.2 5.2"/></g>',
  // gearshape
  settings: '<g class="rot"><path d="M18.9 9.6 20.9 9.6V14.4L18.9 14.5 18.6 15.1 20 16.6 16.6 20 15.1 18.6 14.5 18.9 14.4 20.9H9.6L9.6 18.9 8.9 18.6 7.4 20 4 16.6 5.4 15.1 5.1 14.5 3.1 14.4V9.6L5.1 9.6 5.4 8.9 4 7.4 7.4 4 8.9 5.4 9.6 5.1 9.6 3.1H14.4L14.5 5.1 15.1 5.4 16.6 4 20 7.4 18.6 8.9Z"/><circle cx="12" cy="12" r="3.2"/></g>',
  // arrow.clockwise
  refresh: '<g class="rot"><path d="M17.3 6.7A7.5 7.5 0 1 1 12 4.5"/><path d="M9.6 2.1 12 4.5 9.6 6.9"/></g>',
  // archivebox / archivebox + arrow.up
  archive: '<rect class="lid" x="3" y="4" width="18" height="4.5" rx="1.3"/><path d="M4.8 8.5v9.7a2 2 0 0 0 2 2h10.4a2 2 0 0 0 2-2V8.5"/><path d="M10 12.5h4"/>',
  unarchive: '<rect class="lid" x="3" y="4" width="18" height="4.5" rx="1.3"/><path d="M4.8 8.5v9.7a2 2 0 0 0 2 2h10.4a2 2 0 0 0 2-2V8.5"/><g class="arrow"><path d="M12 17.5v-6"/><path d="m9.4 14 2.6-2.6 2.6 2.6"/></g>',
  trash: '<path d="M4 6.5h16"/><path d="M9 6.5V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v1.5"/><path d="m6 6.5.9 12.7a2 2 0 0 0 2 1.8h6.2a2 2 0 0 0 2-1.8L18 6.5"/><path d="M10 10.5v6.5M14 10.5v6.5"/>',
  // doc.on.doc
  copy: '<rect x="4" y="8" width="11.5" height="13" rx="2"/><path d="M8.5 8V5a2 2 0 0 1 2-2H18a2 2 0 0 1 2 2v9.5a2 2 0 0 1-2 2h-2.5"/>',
  tag: '<path d="M3.5 11.4V5.5a2 2 0 0 1 2-2h5.9a2 2 0 0 1 1.4.6l7.6 7.6a2 2 0 0 1 0 2.8l-5.9 5.9a2 2 0 0 1-2.8 0L4.1 12.8a2 2 0 0 1-.6-1.4z"/><circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none"/>',
  cloud: '<path d="M7 19h10.5a4.5 4.5 0 0 0 .7-8.95A6 6 0 0 0 6.6 9.5 4.75 4.75 0 0 0 7 19z"/>',
  folder: '<path d="M3 17.5v-11A2.5 2.5 0 0 1 5.5 4h3.6a2 2 0 0 1 1.5.7L12 6.5h6.5A2.5 2.5 0 0 1 21 9v8.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/><path d="M3 9.5h18"/>',
  folderOpen: '<path d="M3 17V6.5A2.5 2.5 0 0 1 5.5 4h3.6a2 2 0 0 1 1.5.7L12 6.5h6a2.5 2.5 0 0 1 2.5 2.5v1"/><path d="M3 17.5 5.4 11.6A2 2 0 0 1 7.3 10.3h13.2a1 1 0 0 1 .9 1.4l-2.6 6.4a3 3 0 0 1-2.8 1.9H5.2A2.2 2.2 0 0 1 3 17.5z"/>',
  repo: '<path d="M3 17.5v-11A2.5 2.5 0 0 1 5.5 4h3.6a2 2 0 0 1 1.5.7L12 6.5h6.5A2.5 2.5 0 0 1 21 9v8.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/><circle cx="9.5" cy="13.5" r="1.6"/><circle cx="14.5" cy="13.5" r="1.6"/><path d="M11.1 13.5h1.8"/>',
  commit: '<path d="M2.5 12h5M16.5 12h5"/><circle class="dot" cx="12" cy="12" r="4.2"/>',
  plus: '<path d="M12 4.5v15M4.5 12h15"/>',
  minus: '<path d="M4.5 12h15"/>',
  x: '<path d="m6.5 6.5 11 11M17.5 6.5l-11 11"/>',
  // sparkles
  sparkle: '<path class="sp" d="M10 3.5c.6 3.8 2.6 5.8 6.4 6.4-3.8.6-5.8 2.6-6.4 6.4-.6-3.8-2.6-5.8-6.4-6.4 3.8-.6 5.8-2.6 6.4-6.4z"/><path d="M17.8 14.5c.3 1.9 1.3 2.9 3.2 3.2-1.9.3-2.9 1.3-3.2 3.2-.3-1.9-1.3-2.9-3.2-3.2 1.9-.3 2.9-1.3 3.2-3.2z"/>',
  pencil: '<path d="M15.6 4.4a2 2 0 0 1 2.8 0l1.2 1.2a2 2 0 0 1 0 2.8L8.5 19.5 3.5 20.5l1-5z"/><path d="m13.5 6.5 4 4"/>',
  // sidebar.left / sidebar.right
  panelLeft: '<rect x="2.5" y="4" width="19" height="16" rx="3"/><path d="M9.5 4v16M5.3 8h1.6M5.3 11h1.6M5.3 14h1.6"/>',
  panelRight: '<rect x="2.5" y="4" width="19" height="16" rx="3"/><path d="M14.5 4v16M17.1 8h1.6M17.1 11h1.6M17.1 14h1.6"/>',
  history: '<circle cx="12" cy="12" r="9"/><path class="hand" d="M12 7v5l3.2 2"/>',
  terminal: '<rect x="2.5" y="4" width="19" height="16" rx="3"/><path d="m6.5 9.5 3 2.5-3 2.5"/><path class="cursor" d="M12 15h5"/>',
  people: '<circle cx="9" cy="8" r="3.2"/><path d="M3 19.5c.3-3.4 2.8-5.7 6-5.7s5.7 2.3 6 5.7z"/><path d="M16 5.2a3 3 0 0 1 0 5.6M17.5 14.2c2 .7 3.3 2.6 3.5 5.3h-2.2"/>',
  merge: '<circle cx="6.5" cy="5.5" r="2.2"/><circle cx="6.5" cy="18.5" r="2.2"/><circle cx="17.5" cy="12" r="2.2"/><path d="M6.5 7.7v8.6"/><path class="b-curve" pathLength="24" d="M6.5 7.7c0 3.6 4.2 4.3 8.8 4.3"/>',
  branchPlus: '<circle cx="6.5" cy="5.5" r="2.2"/><circle cx="6.5" cy="18.5" r="2.2"/><path d="M6.5 7.7v8.6"/><path class="b-curve" pathLength="24" d="M15 9.5c0 4.5-4 4.6-8.5 6.8"/><path d="M18 3v6M15 6h6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path class="rot" d="M12 3c2.5 2.4 3.8 5.4 3.8 9s-1.3 6.6-3.8 9c-2.5-2.4-3.8-5.4-3.8-9S9.5 5.4 12 3z"/><path d="M3 12h18M4.5 7.5h15M4.5 16.5h15"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5c.4-4 3.6-6.8 7.5-6.8s7.1 2.8 7.5 6.8z"/>',
  laptop: '<rect x="4.5" y="5" width="15" height="10.5" rx="1.8"/><path d="M2 18.5h20"/>',
  monitor: '<rect x="2.5" y="3.5" width="19" height="13" rx="2"/><path d="M9 20.5h6M12 16.5v4"/>',
  key: '<circle cx="8" cy="15.5" r="4.5"/><path d="m11.2 12.3 8.3-8.3M16.5 7l2.5 2.5M14 9.5l2 2"/><circle cx="6.8" cy="16.7" r="1" fill="currentColor" stroke="none"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  shield: '<path d="M12 3 19.5 5.8v5.7c0 4.6-3.1 8-7.5 9.5-4.4-1.5-7.5-4.9-7.5-9.5V5.8z"/><path class="chk" pathLength="24" d="m8.6 12.2 2.4 2.4 4.4-4.8"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18c1.3 0 2-.8 2-1.8 0-1.4-1.2-1.7-1.2-2.9 0-1 .8-1.8 1.9-1.8h2.1A4.2 4.2 0 0 0 21 10.3C20.1 6.1 16.4 3 12 3z"/><circle cx="7.5" cy="11" r="1.3" fill="currentColor" stroke="none"/><circle cx="10" cy="7" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="7.2" r="1.3" fill="currentColor" stroke="none"/>',
  // info.circle / exclamationmark.triangle with filled dots
  info: '<circle cx="12" cy="12" r="9"/><path d="M10.5 10.8H12v5.7M10 16.5h4"/><circle cx="12" cy="7.6" r="1.2" fill="currentColor" stroke="none"/>',
  warning: '<path d="M10.3 4.3 2.9 17.2A2 2 0 0 0 4.6 20.2h14.8a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z"/><path d="M12 9.5v4.5"/><circle cx="12" cy="17" r="1.1" fill="currentColor" stroke="none"/>',
  // doc.text / doc
  receipt: '<path d="M6 3h12v18l-2.4-1.6L13.2 21l-2.4-1.6L8.4 21 6 19.4z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  fileCode: '<path d="M13.5 3H7a2.5 2.5 0 0 0-2.5 2.5v13A2.5 2.5 0 0 0 7 21h10a2.5 2.5 0 0 0 2.5-2.5V9z"/><path d="M13.5 3v4a2 2 0 0 0 2 2h4"/><path d="m10 12.5-2 2.3 2 2.3M14 12.5l2 2.3-2 2.3"/>',
  fileDiff: '<path d="M13.5 3H7a2.5 2.5 0 0 0-2.5 2.5v13A2.5 2.5 0 0 0 7 21h10a2.5 2.5 0 0 0 2.5-2.5V9z"/><path d="M13.5 3v4a2 2 0 0 0 2 2h4"/><path d="M12 11.5v4.5M9.8 13.8h4.4M9.8 18h4.4"/>',
  note: '<path d="M13.5 3H7a2.5 2.5 0 0 0-2.5 2.5v13A2.5 2.5 0 0 0 7 21h10a2.5 2.5 0 0 0 2.5-2.5V9z"/><path d="M13.5 3v4a2 2 0 0 0 2 2h4"/><path d="M9.5 15h5"/>',
  notePlus: '<path d="M13.5 3H7a2.5 2.5 0 0 0-2.5 2.5v13A2.5 2.5 0 0 0 7 21h10a2.5 2.5 0 0 0 2.5-2.5V9z"/><path d="M13.5 3v4a2 2 0 0 0 2 2h4"/><path d="M12 12.5v5M9.5 15h5"/>',
  noteEdit: '<path d="M13.5 3H7a2.5 2.5 0 0 0-2.5 2.5v13A2.5 2.5 0 0 0 7 21h10a2.5 2.5 0 0 0 2.5-2.5V9z"/><path d="M13.5 3v4a2 2 0 0 0 2 2h4"/><path d="m9 17.5.5-2 3.8-3.8 1.5 1.5-3.8 3.8z"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7L11.3 7"/><path d="M14 10a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 0 0 5.7 5.7l1.3-1.3"/>',
  // arrow.uturn.backward / forward
  undo: '<g class="swing"><path d="M8.5 13.5 4 9l4.5-4.5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></g>',
  redo: '<g class="swing"><path d="M15.5 13.5 20 9l-4.5-4.5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/></g>',
  target: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  zoomIn: '<g class="lens"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.3 15.3 5.2 5.2"/></g><path d="M10.5 7.8v5.4M7.8 10.5h5.4"/>',
  zoomOut: '<g class="lens"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.3 15.3 5.2 5.2"/></g><path d="M7.8 10.5h5.4"/>',
  // return
  send: '<path d="M19.5 5v6a3 3 0 0 1-3 3H5"/><path d="m9 10-4 4 4 4"/>',
  // arrow.up.right.square
  open: '<rect x="3.5" y="3.5" width="17" height="17" rx="3.5"/><path d="M9.5 14.5 15 9M10.5 9H15v4.5"/>',
  square: '<rect x="4.5" y="4.5" width="15" height="15" rx="3"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><circle cx="7" cy="7.5" r="1" fill="currentColor" stroke="none"/><circle cx="7" cy="16.5" r="1" fill="currentColor" stroke="none"/>',
  loader: '<circle cx="12" cy="12" r="8.5" opacity=".22"/><path class="spin" d="M12 3.5a8.5 8.5 0 0 1 8.5 8.5"/>',
  // tree
  tree: '<path d="M8.2 16.5a4.3 4.3 0 0 1-1.9-8.2 5.8 5.8 0 0 1 11.4 0 4.3 4.3 0 0 1-1.9 8.2z"/><path d="M12 21v-9M12 14.5l-2.4-2M12 13l2.2-1.8"/>',
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
  Square: 'square', Server: 'server', TreePine: 'tree',
};
const LUCIDE = { AlertTriangle, Archive, ArchiveRestore, ArrowDown, ArrowUp, ArrowUpRight, Check, ChevronDown, ChevronRight, ChevronUp, Clock3, Cloud, Copy, CornerDownLeft, Download, FileCode2, FileDiff, FileMinus2, FilePenLine, FilePlus2, FileSymlink, Folder, FolderGit2, FolderOpen, GitBranch, GitBranchPlus, GitCommitHorizontal, GitMerge, Globe2, Info, KeyRound, Laptop, Loader2, LocateFixed, Lock, LockKeyhole, Minus, Monitor, Palette, PanelStart, PanelEnd, Pencil, Plus, RefreshCw, RotateCcw, RotateCw, ScrollText, Search, Server, Settings, ShieldCheck, Sparkles, Square, SquareTerminal, Tag, Trash2, TreePine, Undo2, Upload, User, UserRound, X, ZoomIn, ZoomOut };
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
      return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className={`ai apple-glyph lucide lucide-${name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`).replace(/^-/, '')}${className ? ` ${className}` : ''}`} {...rest} aria-hidden="true" dangerouslySetInnerHTML={{ __html: APPLE_PARTS[apple] }} />;
    }
    return <Lucide {...props as object} />;
  };
}
/** Same props as the Lucide icon of the same name; the active design family picks the glyph. */
export const Icons = Object.fromEntries(Object.keys(LUCIDE).map(name => [name, makeIcon(name as keyof typeof LUCIDE)])) as Record<keyof typeof LUCIDE, (props: IconProps & { animated?: boolean }) => ReactElement>;
