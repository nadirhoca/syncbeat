/**
 * YouTube Utility Helper
 * Handles extraction of video IDs from various URL formats
 * and fetching public metadata via YouTube's oEmbed endpoint.
 */

/**
 * Extracts a standard 11-character YouTube video ID from various URL patterns or raw ID.
 * @param {string} input 
 * @returns {string|null}
 */
function extractVideoId(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();

  // If already an 11-character video ID
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return trimmed;
  }

  // Common YouTube URL regex patterns
  const patterns = [
    /(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/|live\/))([a-zA-Z0-9_-]{11})/i,
    /youtube\.com\/playlist\?list=.*&v=([a-zA-Z0-9_-]{11})/i
  ];

  for (const regex of patterns) {
    const match = trimmed.match(regex);
    if (match && match[1]) {
      return match[1];
    }
  }

  return null;
}

/**
 * Fetches public video metadata using YouTube's oEmbed service.
 * Does not require an API key and operates with high reliability.
 * @param {string} videoId 
 * @returns {Promise<{ title: string, author: string, thumbnailUrl: string }>}
 */
async function fetchVideoMetadata(videoId) {
  const fallback = {
    title: `YouTube Track (${videoId})`,
    author: 'YouTube Stream',
    thumbnailUrl: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
  };

  if (!videoId) return fallback;

  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);

    const response = await fetch(oembedUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SyncBeat/1.0)'
      }
    });
    clearTimeout(timeoutId);

    if (response.ok) {
      const data = await response.json();
      return {
        title: data.title || fallback.title,
        author: data.author_name || fallback.author,
        thumbnailUrl: data.thumbnail_url || fallback.thumbnailUrl
      };
    }
  } catch (err) {
    // Graceful fallback on network timeout or oembed failure
  }

  return fallback;
}

module.exports = {
  extractVideoId,
  fetchVideoMetadata
};
