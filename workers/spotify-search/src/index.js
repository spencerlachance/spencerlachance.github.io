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

export default {
	async fetch(request, env) {
		if (request.method === "OPTIONS") {
			return new Response(null, { headers: CORS_HEADERS });
		}

		const url = new URL(request.url);
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

		return json({ url: spotifyUrl });
	},
};
