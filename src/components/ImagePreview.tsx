import { useState, type ReactNode } from 'react';
import type { ImageDiff, ImageSide } from '../model/repository';

function ImageVersion({ label, side }: { label: string; side: ImageSide }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  return <figure className="image-diff-version">
    <figcaption>{label}{' · '}{side.path}</figcaption>
    {side.dataUrl && side.dataUrl !== failedSrc
      ? <img src={side.dataUrl} alt={`${label}: ${side.path}`} onError={() => setFailedSrc(side.dataUrl)} />
      : <p role="status">{side.error ?? 'This image could not be displayed. The format may be unsupported or the file may be invalid.'}</p>}
  </figure>;
}

export function ImagePreview({ image, children }: { image: ImageDiff; children: ReactNode }) {
  const [showSource, setShowSource] = useState(false);
  return <>
    {image.sourceDiff && <div className="image-diff-toolbar">
      <button type="button" className="secondary-button" onClick={() => setShowSource(value => !value)}>
        {showSource ? 'View image' : 'View source diff'}
      </button>
    </div>}
    {showSource ? children : <div className="image-diff-versions">
      {image.before && <ImageVersion label="Before" side={image.before} />}
      {image.after && <ImageVersion label="After" side={image.after} />}
    </div>}
  </>;
}
