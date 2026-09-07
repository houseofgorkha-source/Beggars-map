import { useEffect } from 'react';

export interface MetaTags {
  title?: string;
  description?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogUrl?: string;
}

export function useMetaTags(tags: MetaTags) {
  useEffect(() => {
    if (tags.title) {
      document.title = tags.title;
    }

    const updateMeta = (name: string, content: string | undefined) => {
      if (!content) return;
      let el = document.querySelector(`meta[name="${name}"]`) || document.querySelector(`meta[property="${name}"]`);
      if (!el) {
        el = document.createElement('meta');
        el.setAttribute(name.startsWith('og:') ? 'property' : 'name', name);
        document.head.appendChild(el);
      }
      el.setAttribute('content', content);
    };

    if (tags.description) updateMeta('description', tags.description);
    if (tags.ogTitle) updateMeta('og:title', tags.ogTitle);
    if (tags.ogDescription) updateMeta('og:description', tags.ogDescription);
    if (tags.ogUrl) updateMeta('og:url', tags.ogUrl);
  }, [tags]);
}
