/**
 * Zoho OAuth access token provider (shared by export/ and create/).
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
// Credentials come from zoho_credentials.json next to this file (gitignored; copy
// zoho_credentials.example.json), or from the ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET /
// ZOHO_REFRESH_TOKEN / ZOHO_DATA_CENTER environment variables, which take precedence.
const CREDENTIALS_FILE = path.join(__dirname, 'zoho_credentials.json');

function loadCredentials() {
	let file = {};
	try {
		file = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
	} catch (e) {
		// env vars only
	}

	const creds = {
		clientId: process.env.ZOHO_CLIENT_ID || file.client_id,
		clientSecret: process.env.ZOHO_CLIENT_SECRET || file.client_secret,
		refreshToken: process.env.ZOHO_REFRESH_TOKEN || file.refresh_token,
		// Data centre of the Zoho account: "in", "com", "eu", "com.au", "jp", "ca", "sa", "com.cn"
		dataCenter: process.env.ZOHO_DATA_CENTER || file.data_center || 'in',
	};
	if (!creds.clientId || !creds.clientSecret || !creds.refreshToken) {
		throw new Error(`Zoho credentials missing: fill in ${CREDENTIALS_FILE} (see zoho_credentials.example.json) or set ZOHO_* env vars`);
	}
	return creds;
}

const { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, refreshToken: REFRESH_TOKEN, dataCenter: DATA_CENTER } = loadCredentials();

// Access token is cached next to this file (shared by export/ and create/)
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
