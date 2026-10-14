#!/usr/bin/env node
/**
 * Zoho CRM field metadata exporter.
 *
 * Fill in the CONFIG block below (credentials live in ../zoho_auth.js), then run:
 *     node zoho_export_fields.js                      # uses USE_SANDBOX below
 *     node zoho_export_fields.js --env production
 *     node zoho_export_fields.js --env sandbox
 *
 * For every module listed it writes, into OUTPUT_DIR/<sandbox|production>/:
 *     <Module>_fields.json   raw API response (everything Zoho returns)
 *     <Module>_fields.csv    flat sheet: label, API name, type, mandatory, picklist values, lookup ...
 *     all_fields.csv         every module combined
 *
 * The access token comes from ../zoho_auth.js, which caches and rotates it.
 *
 * No third-party packages needed (Node 18+).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { DATA_CENTER, getAccessToken } = require('../auth/zoho_auth');

// ==================================================
// CONFIG
// ==================================================
// Default org when --env is not passed:
// true -> sandbox (sandbox.zohoapis.<dc>), false -> production (www.zohoapis.<dc>)
let USE_SANDBOX = true;

// Module API names. Use ['ALL'] to export every API-supported module in the org.
const MODULES = ['Leads', 'Contacts', 'Calls'];

const API_VERSION = 'v8';
// Exports go next to this script: export/zoho_fields_output/<sandbox|production>/
const OUTPUT_DIR = path.join(__dirname, 'zoho_fields_output');

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

// ==================================================
// EXPORT
// ==================================================
const CSV_COLUMNS = [
	'module', 'field_label', 'api_name', 'data_type', 'json_type', 'length',
	'system_mandatory', 'custom_field', 'read_only', 'unique',
	'lookup_module', 'picklist_values', 'default_value', 'formula', 'id',
];

function isPlainObject(v) {
	return v !== null && typeof v === 'object' && !Array.isArray(v);
}

async function listAllModules() {
	const modules = (await apiGet('settings/modules')).modules || [];
	return modules.filter((m) => m.api_supported).map((m) => m.api_name);
}

function flattenField(module, f) {
	const picklist = f.pick_list_values || [];
	const lookup = (f.lookup || {}).module || {};
	const formula = f.formula || {};
	return {
		module,
		field_label: f.field_label ?? '',
		api_name: f.api_name ?? '',
		data_type: f.data_type ?? '',
		json_type: f.json_type ?? '',
		length: f.length ?? '',
		system_mandatory: f.system_mandatory ?? '',
		custom_field: f.custom_field ?? '',
		read_only: f.read_only ?? '',
		unique: isPlainObject(f.unique) ? Boolean(f.unique.casesensitive) : (f.unique ?? ''),
		lookup_module: isPlainObject(lookup) ? (lookup.api_name ?? '') : lookup,
		picklist_values: picklist.map((p) => String(p.actual_value ?? p.display_value ?? '')).join(' | '),
		default_value: f.default_value || '',
		formula: isPlainObject(formula) ? (formula.expression ?? '') : '',
		id: f.id ?? '',
	};
}

// Same cell formatting as Python's csv module (True / False, quoted when needed, CRLF rows)
function csvCell(value) {
	let s;
	if (value === null || value === undefined) {
		s = '';
	} else if (typeof value === 'boolean') {
		s = value ? 'True' : 'False';
	} else if (typeof value === 'object') {
		s = JSON.stringify(value);
	} else {
		s = String(value);
	}
	return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function writeCsv(filePath, rows) {
	const lines = [CSV_COLUMNS.join(',')];
	for (const row of rows) {
		lines.push(CSV_COLUMNS.map((c) => csvCell(row[c])).join(','));
	}
	fs.writeFileSync(filePath, lines.join('\r\n') + '\r\n', 'utf8');
}

async function main() {
	applyEnvArg();
	const outDir = path.join(OUTPUT_DIR, envName());
	fs.mkdirSync(outDir, { recursive: true });
	console.log(`Org : ${envName()}`);

	const isAll = MODULES.length === 1 && MODULES[0].toUpperCase() === 'ALL';
	const modules = isAll ? await listAllModules() : MODULES;
	const allRows = [];

	for (const module of modules) {
		let resp;
		try {
			resp = await apiGet('settings/fields', { module });
		} catch (e) {
			console.log(`  ✗ ${module}: ${e.message}`);
			continue;
		}

		const fields = resp.fields || [];
		fs.writeFileSync(path.join(outDir, `${module}_fields.json`), JSON.stringify(resp, null, 2), 'utf8');

		const rows = fields.map((f) => flattenField(module, f));
		writeCsv(path.join(outDir, `${module}_fields.csv`), rows);
		allRows.push(...rows);
		console.log(`  ✓ ${module}: ${fields.length} fields`);
	}

	writeCsv(path.join(outDir, 'all_fields.csv'), allRows);
	console.log(`\nDone. ${allRows.length} fields written to ${path.resolve(outDir)}`);
}

module.exports = { apiRequest, apiGet, applyEnvArg, envName };

if (require.main === module) {
	main().catch((e) => {
		console.error(`ERROR: ${e.message}`);
		process.exit(1);
	});
}
