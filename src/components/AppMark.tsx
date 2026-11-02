/** The app icon from app-icon.svg, cropped to its macOS-grid body so it can render as a small tile in the titlebar. Keep the two in sync. */
export function AppMark() {
  return <svg viewBox="99.2 99.2 825.6 825.6" aria-hidden="true" data-tauri-drag-region>
    <g transform="translate(512 512) scale(.86) translate(-512 -512)">
      <rect x="32" y="32" width="960" height="960" rx="226" fill="#29292d" />
      <rect x="62" y="62" width="900" height="900" rx="205" fill="#141416" />
      <g fill="none" stroke="#f07a3d" strokeWidth={48} strokeLinecap="round" strokeLinejoin="round">
        <path pathLength={1} d="M363 302v420M665 302v82c0 116-58 141-151 177S363 623 363 722" />
        <circle pathLength={1} cx="363" cy="302" r="65" fill="#141416" />
        <circle pathLength={1} cx="665" cy="302" r="65" fill="#141416" />
        <circle pathLength={1} cx="363" cy="722" r="65" fill="#141416" />
      </g>
    </g>
  </svg>;
}
