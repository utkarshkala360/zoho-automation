/**
 * Common Zoho CRM API helpers (shared by fields/export and fields/create).
 *
 *   apiRequest / apiGet   authorised CRM calls; if Zoho rejects the token, rotate once and retry
 *   applyEnvArg / envName `--env sandbox|production` switch (sandbox.zohoapis vs www.zohoapis)
 *
 * The access token comes from ../auth/zoho_auth.js, which caches and rotates it.
 *
 * No third-party packages needed (Node 18+).
 */

'use strict';

const { DATA_CENTER, getAccessToken } = require('../auth/zoho_auth');

// ==================================================
// CONFIG
// ==================================================
// Default org when --env is not passed: ZOHO_ENV in .env (sandbox | production), else sandbox.
// true -> sandbox (sandbox.zohoapis.<dc>), false -> production (www.zohoapis.<dc>)
let USE_SANDBOX = !['production', 'prod'].includes((process.env.ZOHO_ENV || 'sandbox').toLowerCase());

const API_VERSION = 'v8';

// ==================================================
// HTTP HELPERS
// ==================================================
class AuthError extends Error {}

async function httpRequest(url, { method = 'GET', headers = {}, jsonBody } = {}) {
	headers = { ...headers };
	let body;
	if (jsonBody !== undefined && jsonBody !== null) {
		body = JSON.stringify(jsonBody);
		headers['Content-Type'] = 'application/json';
	}

	const resp = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(60000) });
	const raw = await resp.text();
	if (!resp.ok) {
		if (resp.status === 401 || raw.includes('INVALID_TOKEN') || raw.includes('AUTHENTICATION_FAILURE')) {
			throw new AuthError(`HTTP ${resp.status} on ${url}\n${raw}`);
		}
		throw new Error(`HTTP ${resp.status} on ${url}\n${raw}`);
	}
	return raw ? JSON.parse(raw) : {};
}

// ==================================================
// ENVIRONMENT (sandbox / production)
// ==================================================
function envName() {
	return USE_SANDBOX ? 'sandbox' : 'production';
}

/** Honour `--env sandbox|production` on the command line (overrides USE_SANDBOX). */
function applyEnvArg(argv = process.argv.slice(2)) {
	const i = argv.indexOf('--env');
	if (i !== -1) {
		const value = (argv[i + 1] || '').toLowerCase();
		if (!['sandbox', 'production', 'prod'].includes(value)) {
			console.error("ERROR: --env must be 'sandbox' or 'production'");
			process.exit(1);
		}
		USE_SANDBOX = value === 'sandbox';
	}
}

// ==================================================
// CRM API
// ==================================================
async function apiRequest(method, apiPath, params, jsonBody) {
	const host = USE_SANDBOX ? 'sandbox.zohoapis' : 'www.zohoapis';
	let url = `https://${host}.${DATA_CENTER}/crm/${API_VERSION}/${apiPath}`;
	if (params && Object.keys(params).length > 0) {
		url += '?' + new URLSearchParams(params).toString();
	}

	const send = (token) => httpRequest(url, { method, jsonBody, headers: { Authorization: `Zoho-oauthtoken ${token}` } });
	try {
		return await send(await getAccessToken());
	} catch (e) {
		if (!(e instanceof AuthError)) {
			throw e;
		}
		// Token rejected (revoked / expired early) -> rotate once and retry
		return send(await getAccessToken({ forceRefresh: true }));
	}
}

function apiGet(apiPath, params) {
	return apiRequest('GET', apiPath, params);
}

module.exports = { apiRequest, apiGet, applyEnvArg, envName };
