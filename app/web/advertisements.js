// Only cached, same-origin images and ordinary HTTPS destinations enter the carousel.
export function normalizeAdvertisements(payload, origin) {
  if (!Array.isArray(payload?.ads)) return [];
  const seen = new Set();
  const ads = [];
  for (const candidate of payload.ads.slice(0, 32)) {
    if (!candidate || typeof candidate.id !== 'string' || !candidate.id || candidate.id.length > 128 || seen.has(candidate.id)) continue;
    if (typeof candidate.image_url !== 'string' || typeof candidate.link_url !== 'string') continue;
    try {
      const image = new URL(candidate.image_url, origin);
      const link = new URL(candidate.link_url);
      if (image.origin !== origin || image.username || image.password || !/^\/ad-assets\/[a-zA-Z0-9._-]+$/.test(image.pathname) || image.search || image.hash) continue;
      if (link.protocol !== 'https:' || link.username || link.password) continue;
      seen.add(candidate.id);
      ads.push({ id: candidate.id, image_url: image.href, link_url: link.href });
    } catch { /* malformed entries leave the local sponsorship card available */ }
  }
  return ads;
}
export function nextAdvertisementIndex(index, count) {
  return count > 0 ? (index + 1) % count : 0;
}
