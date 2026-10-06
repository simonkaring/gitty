import { useEffect, useRef, useState } from 'react';
import { gravatarImageFailed, gravatarUrl, markGravatarImageFailed } from '../model/gravatar';
import type { AuthorAvatarMode } from '../model/settings';
import { initials } from './ui';

export function AuthorAvatar({ name, email, mode = 'initials', tiny = false }: { name: string; email: string; mode?: AuthorAvatarMode; tiny?: boolean }) {
  const [image, setImage] = useState<{ key: string; url: string } | null>(null);
  const key = `${mode}\u0000${email}`;
  const currentKey = useRef(key);
  currentKey.current = key;
  useEffect(() => {
    let live = true;
    setImage(null);
    if (mode === 'gravatar' && !gravatarImageFailed(email)) {
      void gravatarUrl(email).then(url => { if (live && url) setImage({ key, url }); });
    }
    return () => { live = false; };
  }, [email, key, mode]);
  const visible = mode === 'gravatar' && image?.key === key ? image.url : null;
  return <span className={`avatar${tiny ? ' tiny' : ''}`}>
    {initials(name)}
    {visible && <img key={visible} src={visible} alt="" referrerPolicy="no-referrer" decoding="async" draggable={false} onLoad={event => { if (currentKey.current === key) event.currentTarget.style.opacity = '1'; }} onError={() => { if (currentKey.current === key) { markGravatarImageFailed(email); setImage(null); } }} />}
  </span>;
}
