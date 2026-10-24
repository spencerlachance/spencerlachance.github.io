const TOKEN_CACHE_KEY = "https://internal/spotify-token";

async function getToken(env) {
	const cache = caches.default;
	const hit = await cache.match(TOKEN_CACHE_KEY);
	if (hit) return (await hit.json()).access_token;

	const res = await fetch("https://accounts.spotify.com/api/token", {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			"Authorization": "Basic " + btoa(env.SPOTIFY_CLIENT_ID + ":" + env.SPOTIFY_CLIENT_SECRET),
		},
		body: "grant_type=client_credentials",
	});
	if (!res.ok) throw new Error("Token request failed: " + res.status);
	const data = await res.json();
	const ttl = (data.expires_in || 3600) - 60;
	await cache.put(TOKEN_CACHE_KEY, new Response(JSON.stringify(data), {
		headers: { "Cache-Control": "public, max-age=" + ttl },
	}));
	return data.access_token;
}

const CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status) {
	return new Response(JSON.stringify(data), {
		status: status || 200,
		headers: Object.assign({ "Content-Type": "application/json" }, CORS_HEADERS),
	});
}

async function handleSearch(request, env, url) {
	const q = url.searchParams.get("q");
	const type = url.searchParams.get("type") || "track";

	if (!q) return json({ error: "Missing q parameter" }, 400);
	if (type !== "track" && type !== "album") return json({ error: "type must be track or album" }, 400);

	let token;
	try {
		token = await getToken(env);
	} catch (e) {
		return json({ error: "Spotify auth failed" }, 502);
	}

	const searchRes = await fetch(
		"https://api.spotify.com/v1/search?" + new URLSearchParams({ q, type, limit: "1" }),
		{ headers: { "Authorization": "Bearer " + token } }
	);
	if (!searchRes.ok) return json({ error: "Spotify search failed: " + searchRes.status }, 502);

	const data = await searchRes.json();
	const item = type === "album"
		? (data.albums && data.albums.items && data.albums.items[0])
		: (data.tracks && data.tracks.items && data.tracks.items[0]);
	const spotifyUrl = (item && item.external_urls && item.external_urls.spotify) || null;
	const images = (item && (type === "album" ? item.images : item.album && item.album.images)) || [];

	return json({ url: spotifyUrl, artwork: (images[1] || images[0] || {}).url || null });
}

/* ---------- Spotify track/album metadata ---------- */

// Spotify's oEmbed only returns the title — no artist — so the browser can't
// search the other services by "title artist" without this lookup.
async function handleSpotifyMeta(env, url) {
	const target = url.searchParams.get("url") || "";
	const m = /open\.spotify\.com\/(?:intl-[a-z-]+\/)?(track|album)\/([A-Za-z0-9]+)/.exec(target);
	if (!m) return json({ error: "Not a Spotify track or album URL" }, 400);

	let token;
	try {
		token = await getToken(env);
	} catch (e) {
		return json({ error: "Spotify auth failed" }, 502);
	}

	const res = await fetch("https://api.spotify.com/v1/" + m[1] + "s/" + m[2], {
		headers: { "Authorization": "Bearer " + token },
	});
	if (!res.ok) return json({ error: "Spotify lookup failed: " + res.status }, res.status === 404 ? 404 : 502);

	const item = await res.json();
	const images = (m[1] === "album" ? item.images : item.album && item.album.images) || [];
	return json({
		title: item.name || "",
		artist: (item.artists || []).map((a) => a.name).join(", "),
		artwork: (images[1] || images[0] || {}).url || null,
	});
}

/* ---------- YouTube ---------- */

async function handleYoutubeSearch(env, url) {
	const q = url.searchParams.get("q");
	if (!q) return json({ error: "Missing q parameter" }, 400);
	if (!env.YOUTUBE_API_KEY) return json({ error: "YouTube search is not configured" }, 503);

	// search.list costs 100 quota units against a 10,000/day default — that's only
	// 100 searches a day, so cache every lookup aggressively.
	const cache = caches.default;
	// v2: entries cached before artwork was added to the response have none.
	const cacheKey = new Request("https://internal/youtube-search?v=2&q=" + encodeURIComponent(q));
	const cached = await cache.match(cacheKey);
	if (cached) {
		return new Response(cached.body, {
			headers: Object.assign({ "Content-Type": "application/json" }, CORS_HEADERS),
		});
	}

	const res = await fetch("https://www.googleapis.com/youtube/v3/search?" + new URLSearchParams({
		part: "snippet",
		maxResults: "1",
		type: "video",
		videoCategoryId: "10",
		q,
		key: env.YOUTUBE_API_KEY,
	}));
	if (!res.ok) return json({ error: "YouTube search failed: " + res.status }, 502);

	const data = await res.json();
	const item = data.items && data.items[0];
	const videoId = item && item.id && item.id.videoId;
	const thumbs = (item && item.snippet && item.snippet.thumbnails) || {};
	const thumb = thumbs.high || thumbs.medium || thumbs.default;
	const body = JSON.stringify({
		url: videoId ? "https://www.youtube.com/watch?v=" + videoId : null,
		artwork: videoId && thumb ? thumb.url : null,
	});

	await cache.put(cacheKey, new Response(body, {
		headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" },
	}));
	return new Response(body, {
		headers: Object.assign({ "Content-Type": "application/json" }, CORS_HEADERS),
	});
}

/* ---------- Apple Music playlist ---------- */

// Apple renders the whole page server-side and leaves the data behind in a
// <script id="serialized-server-data"> blob. No developer token needed.
const SERIALIZED_DATA_RE = /<script[^>]+id="serialized-server-data"[^>]*>([\s\S]*?)<\/script>/;

function artworkUrl(art, size) {
	const template = art && art.dictionary && art.dictionary.url;
	if (!template) return null;
	return template
		.replace("{w}", size)
		.replace("{h}", size)
		.replace("{f}", "jpg");
}

function parsePlaylist(html) {
	const match = SERIALIZED_DATA_RE.exec(html);
	if (!match) throw new Error("Could not find playlist data on the page");

	const root = JSON.parse(match[1]);
	const sections = (root.data && root.data[0] && root.data[0].data && root.data[0].data.sections) || [];

	const trackSection = sections.find((s) => s.itemKind === "trackLockup");
	if (!trackSection) throw new Error("No track list on the page");

	const header = sections.find((s) => s.itemKind === "containerDetailHeaderLockup");
	const headerItem = (header && header.items && header.items[0]) || {};
	const footer = sections.find((s) => s.itemKind === "containerDetailTracklistFooterLockup");
	const footerItem = (footer && footer.items && footer.items[0]) || {};

	// Footer reads like "100 songs, 4 hours 46 minutes" and reports the real
	// length even when the page only rendered the first chunk of tracks.
	const totalMatch = /^([\d,]+)\s+song/i.exec(footerItem.description || "");
	const total = totalMatch ? parseInt(totalMatch[1].replace(/,/g, ""), 10) : null;

	const tracks = (trackSection.items || []).map((item) => ({
		title: item.title || "",
		artist: item.artistName || (item.subtitleLinks && item.subtitleLinks[0] && item.subtitleLinks[0].title) || "",
		album: (item.tertiaryLinks && item.tertiaryLinks[0] && item.tertiaryLinks[0].title) || "",
		artwork: artworkUrl(item.artwork, 100),
	})).filter((t) => t.title);

	return {
		name: headerItem.title || "Apple Music playlist",
		curator: (headerItem.subtitleLinks && headerItem.subtitleLinks[0] && headerItem.subtitleLinks[0].title) || "",
		artwork: artworkUrl(headerItem.artwork, 300),
		tracks,
		total: total == null ? tracks.length : total,
		truncated: total != null && total > tracks.length,
	};
}

async function handleApplePlaylist(url) {
	const target = url.searchParams.get("url");
	if (!target) return json({ error: "Missing url parameter" }, 400);

	// Only ever fetch Apple Music playlist pages — never a caller-supplied host.
	let parsed;
	try {
		parsed = new URL(target);
	} catch (e) {
		return json({ error: "Invalid url" }, 400);
	}
	if (parsed.protocol !== "https:" || parsed.hostname !== "music.apple.com" || !/\/playlist\//.test(parsed.pathname)) {
		return json({ error: "Not an Apple Music playlist URL" }, 400);
	}

	const pageUrl = "https://music.apple.com" + parsed.pathname;
	const cache = caches.default;
	const cacheKey = new Request("https://internal/apple-playlist?u=" + encodeURIComponent(pageUrl));
	const cached = await cache.match(cacheKey);
	if (cached) return new Response(cached.body, { headers: Object.assign({ "Content-Type": "application/json" }, CORS_HEADERS) });

	const res = await fetch(pageUrl, {
		headers: {
			"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			"Accept": "text/html,application/xhtml+xml",
			"Accept-Language": "en-US,en;q=0.9",
		},
	});
	if (res.status === 404) {
		return json({ error: "Apple Music doesn't have that playlist — it may be private, or the link may be wrong." }, 404);
	}
	if (!res.ok) return json({ error: "Apple Music returned " + res.status }, 502);

	let playlist;
	try {
		playlist = parsePlaylist(await res.text());
	} catch (e) {
		return json({ error: e.message || "Could not read that playlist" }, 502);
	}

	const body = JSON.stringify(playlist);
	await cache.put(cacheKey, new Response(body, {
		headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=1800" },
	}));
	return json(playlist);
}

export default {
	async fetch(request, env) {
		if (request.method === "OPTIONS") {
			return new Response(null, { headers: CORS_HEADERS });
		}

		const url = new URL(request.url);

		if (url.pathname === "/apple-playlist") return handleApplePlaylist(url);
		if (url.pathname === "/youtube-search") return handleYoutubeSearch(env, url);
		if (url.pathname === "/spotify-meta") return handleSpotifyMeta(env, url);

		// The browser needs the client ID to run the PKCE authorization flow.
		// Client IDs are public by design; the secret stays in the Worker.
		if (url.pathname === "/client-id") return json({ clientId: env.SPOTIFY_CLIENT_ID });

		return handleSearch(request, env, url);
	},
};
