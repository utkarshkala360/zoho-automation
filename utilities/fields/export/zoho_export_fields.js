#!/usr/bin/env node
/**
 * Zoho CRM field metadata exporter.
 *
 * Fill in the CONFIG block below (credentials: .env at the repo root), then run:
 *     node zoho_export_fields.js                      # uses ZOHO_ENV from .env (default sandbox)
 *     node zoho_export_fields.js --env production
 *     node zoho_export_fields.js --env sandbox
 *
 * OUTPUT_DIR (zoho_fields_output/) only holds sandbox/ and production/. Each run empties the
 * folder for the org being exported (the other org's folder is kept, anything else is removed),
 * then writes, for every module listed, into OUTPUT_DIR/<sandbox|production>/:
 *     <Module>_fields.json   raw API response (everything Zoho returns)
 *     <Module>_fields.csv    flat sheet: label, API name, type, mandatory, picklist values, lookup ...
 *     all_fields.csv         every module combined
 *
 * API calls go through utilities/common/zoho_api.js; the access token comes from
 * utilities/auth/zoho_auth.js, which caches and rotates it.
 *
 * No third-party packages needed (Node 18+).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { apiGet, applyEnvArg, envName } = require('../../common/zoho_api');

// ==================================================
// CONFIG
// ==================================================
// Module API names. Use ['ALL'] to export every API-supported module in the org.
const MODULES = ['Leads', 'Calls', 'Tasks'];

// Exports go next to this script: export/zoho_fields_output/<sandbox|production>/
const OUTPUT_DIR = path.join(__dirname, 'zoho_fields_output');

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

	// OUTPUT_DIR only holds sandbox/ and production/: clear the folder for this org,
	// keep the other org's folder (if it exists) and remove anything else
	fs.mkdirSync(OUTPUT_DIR, { recursive: true });
	for (const entry of fs.readdirSync(OUTPUT_DIR, { withFileTypes: true })) {
		const keep = entry.isDirectory() && ['sandbox', 'production'].includes(entry.name) && entry.name !== envName();
		if (!keep) {
			fs.rmSync(path.join(OUTPUT_DIR, entry.name), { recursive: true, force: true });
		}
	}
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

if (require.main === module) {
	main().catch((e) => {
		console.error(`ERROR: ${e.message}`);
		process.exit(1);
	});
}
