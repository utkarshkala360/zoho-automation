#!/usr/bin/env node
/**
 * Zoho CRM bulk custom-field creator.
 *
 * Reuses the API helpers and sandbox/production switch from ../export/zoho_export_fields.js,
 * and the access token (cached + auto-rotated) from ../zoho_auth.js, so there is nothing
 * extra to configure.
 *
 *     node zoho_create_fields.js --env sandbox --dry-run    # preview only, creates nothing
 *     node zoho_create_fields.js --env sandbox
 *     node zoho_create_fields.js --env production            # asks for confirmation
 *
 * Behaviour:
 *   - Fields that already exist (same API name or same label) are skipped, so it is safe to re-run.
 *   - Zoho builds the API name from the label; after creating, the script re-reads the
 *     module and confirms each field got the expected API name.
 *   - New fields are given read/write access for every profile in the org.
 *
 * Token scopes needed: ZohoCRM.settings.fields.ALL, ZohoCRM.settings.profiles.READ
 */

'use strict';

const readline = require('readline');
const zoho = require('../export/zoho_export_fields');

// ==================================================
// FIELDS TO CREATE   (module -> list of definitions)
// ==================================================
// type: text | phone | textarea | datetime | integer | website | boolean
const FIELDS = {
	Calls: [
		{ label: 'Call Anchor Call Id', api_name: 'Call_Anchor_Call_Id', type: 'text', length: 255, unique: true },
		{ label: 'Agent Name', api_name: 'Agent_Name', type: 'text', length: 255 },
		{ label: 'Callee Name', api_name: 'Callee_Name', type: 'text', length: 255 },
		// Calls does not support the phone type -> plain text
		{ label: 'Agent Number', api_name: 'Agent_Number', type: 'text', length: 50 },
		{ label: 'Callee Phone Number', api_name: 'Callee_Phone_Number', type: 'text', length: 50 },
		{ label: 'Disposition', api_name: 'Disposition', type: 'text', length: 255 },
		// Calls only allows small (2000-char) text areas
		{ label: 'Disposition Note', api_name: 'Disposition_Note', type: 'textarea', length: 2000, textarea_type: 'small' },
		{ label: 'Follow up Date Time', api_name: 'Follow_up_Date_Time', type: 'datetime' },
	],
};

// ==================================================
// HELPERS
// ==================================================
function firstLine(e) {
	return String(e.message || e).split('\n')[0];
}

async function getProfiles() {
	try {
		const profiles = (await zoho.apiGet('settings/profiles')).profiles || [];
		return profiles.map((p) => ({ id: p.id, permission_type: 'read_write' }));
	} catch (e) {
		console.log(`  ! Could not read profiles, Zoho defaults will apply : ${firstLine(e)}`);
		return [];
	}
}

async function existingFields(module) {
	const fields = (await zoho.apiGet('settings/fields', { module })).fields || [];
	const byApi = {};
	const byLabel = {};
	for (const f of fields) {
		byApi[f.api_name.toLowerCase()] = f;
		byLabel[f.field_label.toLowerCase()] = f;
	}
	return { byApi, byLabel };
}

function buildPayload(defn, profiles, minimal = false) {
	const field = { field_label: defn.label, data_type: defn.type };
	if (defn.length) {
		field.length = defn.length;
	}
	if (defn.type === 'textarea') {
		field.textarea = { type: defn.textarea_type || 'large' };
	}
	if (profiles.length > 0) {
		field.profiles = profiles;
	}
	if (defn.unique && !minimal) {
		field.unique = { casesensitive: false };
	}
	return { fields: [field] };
}

async function createField(module, defn, profiles) {
	try {
		const resp = await zoho.apiRequest('POST', 'settings/fields', { module }, buildPayload(defn, profiles));
		return { resp, uniqueApplied: true };
	} catch (e) {
		if (!defn.unique) {
			throw e;
		}
		// Some orgs / API versions reject the unique flag -> create without it and say so
		console.log(`    ! Unique flag rejected, retrying without it (${firstLine(e)})`);
		const resp = await zoho.apiRequest('POST', 'settings/fields', { module }, buildPayload(defn, profiles, true));
		return { resp, uniqueApplied: false };
	}
}

function ask(question) {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => rl.question(question, (answer) => {
		rl.close();
		resolve(answer);
	}));
}

// ==================================================
// MAIN
// ==================================================
async function main() {
	zoho.applyEnvArg();
	const args = process.argv.slice(2);
	const dryRun = args.includes('--dry-run');
	const env = zoho.envName();
	console.log(`Org : ${env}${dryRun ? '  (DRY RUN - nothing will be created)' : ''}`);

	if (env === 'production' && !dryRun && !args.includes('--yes')) {
		const answer = (await ask("Create fields in PRODUCTION? Type 'yes' to continue: ")).trim().toLowerCase();
		if (answer !== 'yes') {
			console.error('Aborted.');
			process.exit(1);
		}
	}

	const profiles = dryRun ? [] : await getProfiles();
	const summary = { created: 0, skipped: 0, failed: 0, name_mismatch: 0 };

	for (const [module, defs] of Object.entries(FIELDS)) {
		console.log(`\n== ${module} ==`);
		const { byApi, byLabel } = await existingFields(module);
		const created = [];

		for (const defn of defs) {
			const name = defn.api_name.padEnd(28);
			const match = byApi[defn.api_name.toLowerCase()] || byLabel[defn.label.toLowerCase()];
			if (match) {
				console.log(`  = ${name} exists (${match.api_name}, ${match.data_type}) - skipped`);
				summary.skipped += 1;
				continue;
			}

			if (dryRun) {
				console.log(`  + ${name} would be created : ${JSON.stringify(buildPayload(defn, profiles).fields[0])}`);
				continue;
			}

			try {
				const { resp, uniqueApplied } = await createField(module, defn, profiles);
				const result = (resp.fields || [{}])[0] || {};
				if (result.status === 'success') {
					const note = uniqueApplied || !defn.unique ? '' : '  (NOT unique - set it in Zoho UI)';
					console.log(`  ✓ ${name} created${note}`);
					summary.created += 1;
					created.push(defn);
				} else {
					console.log(`  ✗ ${name} failed : ${JSON.stringify(result)}`);
					summary.failed += 1;
				}
			} catch (e) {
				console.log(`  ✗ ${name} failed : ${e.message}`);
				summary.failed += 1;
			}
		}

		// Confirm Zoho generated the API names the Call Anchor function expects
		if (created.length > 0) {
			const after = await existingFields(module);
			for (const defn of created) {
				if (!after.byApi[defn.api_name.toLowerCase()]) {
					const actual = (after.byLabel[defn.label.toLowerCase()] || {}).api_name || '?';
					console.log(`  ! ${defn.label} was created as '${actual}', expected '${defn.api_name}' - rename it in Zoho`);
					summary.name_mismatch += 1;
				}
			}
		}
	}

	console.log(`\nDone (${env}). Created ${summary.created}, skipped ${summary.skipped}, `
		+ `failed ${summary.failed}, API-name mismatches ${summary.name_mismatch}.`);
}

if (require.main === module) {
	main().catch((e) => {
		console.error(`ERROR: ${e.message}`);
		process.exit(1);
	});
}
