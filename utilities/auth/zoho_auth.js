/**
 * Zoho OAuth access token provider (shared by every script under utilities/).
 *
 * getAccessToken() returns the current access token:
 *   - reuses the in-memory token, else the one cached in .zoho_access_token.json
 *   - generates a new one from the refresh token when the cached one is missing,
 *     expired (per its expires_in), or belongs to a different client / data centre
 *   - getAccessToken({ forceRefresh: true }) rotates immediately, for when Zoho
 *     rejects a token that still looked valid (revoked, clock skew ...)
 *
 * No third-party packages needed (Node 18+, built-in fetch).
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ==================================================
// CONFIG
// ==================================================
// Credentials come from the .env file at the repo root (gitignored; copy .env.example).
// Variables already set in the shell take precedence over the file.
const ENV_FILE = path.join(__dirname, '..', '..', '.env');

function loadEnvFile() {
	let text;
	try {
		text = fs.readFileSync(ENV_FILE, 'utf8');
	} catch (e) {
		return; // no .env -> shell env vars only
	}

	for (const line of text.split(/\r?\n/)) {
		const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
		if (!m || process.env[m[1]] !== undefined) {
			continue;
		}

		let value = m[2];
		if (/^(["']).*\1$/.test(value)) {
			value = value.slice(1, -1);
		} else {
			value = value.replace(/\s+#.*$/, ''); // strip inline comment
		}
		process.env[m[1]] = value;
	}
}

loadEnvFile();

const CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
// Data centre of the Zoho account: "in", "com", "eu", "com.au", "jp", "ca", "sa", "com.cn"
const DATA_CENTER = process.env.ZOHO_DATA_CENTER || 'in';

// Checked on first use (not at require time) so callers report it as a normal error
function assertCredentials() {
	if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
		throw new Error(`Zoho credentials missing: set ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET and ZOHO_REFRESH_TOKEN in ${path.resolve(ENV_FILE)} (see .env.example)`);
	}
}

// Access token is cached next to this file (shared by every script under utilities/)
const TOKEN_CACHE_FILE = path.join(__dirname, '.zoho_access_token.json');

// Treat the token as expired this many seconds before Zoho actually expires it
const EXPIRY_MARGIN_SECONDS = 120;

// ==================================================
// TOKEN CACHE
// ==================================================
function nowSeconds() {
	return Math.floor(Date.now() / 1000);
}

function isExpired(cache) {
	// Older cache files may lack expiry info -> use the token and let a rejection rotate it
	if (!cache.created_at || !cache.expires_in) {
		return false;
	}

	return nowSeconds() >= cache.created_at + cache.expires_in - EXPIRY_MARGIN_SECONDS;
}

function loadCachedToken() {
	let cache;
	try {
		cache = JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, 'utf8'));
	} catch (e) {
		return null;
	}

	// Ignore a token cached for a different client / data centre
	if (cache.client_id !== CLIENT_ID || cache.data_center !== DATA_CENTER || !cache.access_token) {
		return null;
	}

	return isExpired(cache) ? null : cache;
}

function saveCachedToken(token, expiresIn) {
	const cache = {
		access_token: token,
		client_id: CLIENT_ID,
		data_center: DATA_CENTER,
		created_at: nowSeconds(),
		expires_in: expiresIn,
	};
	fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(cache, null, 2), { encoding: 'utf8', mode: 0o600 });
	try {
		fs.chmodSync(TOKEN_CACHE_FILE, 0o600);
	} catch (e) {
		// best effort
	}
	return cache;
}

// ==================================================
// ROTATION
// ==================================================
async function refreshAccessToken() {
	const resp = await fetch(`https://accounts.zoho.${DATA_CENTER}/oauth/v2/token`, {
		method: 'POST',
		body: new URLSearchParams({
			refresh_token: REFRESH_TOKEN,
			client_id: CLIENT_ID,
			client_secret: CLIENT_SECRET,
			grant_type: 'refresh_token',
		}),
		signal: AbortSignal.timeout(60000),
	});
	const text = await resp.text();
	let json = {};
	try {
		json = text ? JSON.parse(text) : {};
	} catch (e) {
		// fall through with the raw text in the error below
	}

	if (!json.access_token) {
		throw new Error(`Could not get access token: HTTP ${resp.status} ${text}`);
	}

	const cache = saveCachedToken(json.access_token, json.expires_in);
	console.log('  ↻ New access token generated and cached');
	return cache;
}

let current = null;
let pendingRefresh = null;

async function getAccessToken({ forceRefresh = false } = {}) {
	assertCredentials();
	if (!forceRefresh) {
		if (current && !isExpired(current)) {
			return current.access_token;
		}

		current = loadCachedToken();
		if (current) {
			return current.access_token;
		}
	}

	// Concurrent callers share one refresh request
	if (!pendingRefresh) {
		pendingRefresh = refreshAccessToken().finally(() => {
			pendingRefresh = null;
		});
	}
	current = await pendingRefresh;
	return current.access_token;
}

module.exports = { DATA_CENTER, getAccessToken };
