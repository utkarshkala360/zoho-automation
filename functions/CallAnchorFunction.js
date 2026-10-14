'use strict';

// ==================================================
// CONFIG
// ==================================================
// Field used to detect duplicate webhooks for the same call (update instead of create)
const callIdField = 'Call_Anchor_Call_Id';

// Fields written only when a Lead is CREATED, never on update
const createOnlyFields = ['Last_Name', 'Phone', 'Lead_Source'];

// Webhook timestamps (UTC) that get converted to IST before mapping
const dateSourcePaths = ['call.startedAt', 'call.dispositionScheduledAt', 'disposition.submittedAt', 'disposition.fields.scheduled-at'];

// --------------------------------------------------
// CALLS FIELD MAP   (source path -> Zoho field API name[s], comma separated)
// Incoming, Outgoing, Missed and Rejected calls all use the same fields;
// direction comes from Call_Type, Answered / Rejected / Missed status from Subject + Description.
// Disposition is kept as free text (not the Call_Result picklist) and also
// written into Description.
// --------------------------------------------------
const callFieldMap = {
	'derived.subject': 'Subject',
	'derived.callType': 'Call_Type',
	'derived.outgoingCallStatus': 'Outgoing_Call_Status',
	'derived.callDuration': 'Call_Duration',
	'derived.callDurationSeconds': 'Call_Duration_in_seconds',
	'derived.description': 'Description',
	'derived.recordingUrl': 'Voice_Recording__s',
	'call.startedAt': 'Call_Start_Time',
	'call.id': 'Call_Anchor_Call_Id',
	'call.agentName': 'Agent_Name',
	'call.agentNumber': 'Agent_Number',
	'call.calleeName': 'Callee_Name',
	'call.calleePhone': 'Callee_Phone_Number',
	'call.dispositionLabel': 'Disposition',
	'call.dispositionNote': 'Disposition_Note',
	'call.dispositionScheduledAt': 'Follow_up_Date_Time',

	// 'event': 'Webhook_Event',
	// 'hasRecording': 'Has_Recording',
	// 'disposition.submittedAt': 'Disposition_Submitted_At',
};

// --------------------------------------------------
// LEADS FIELD MAP
// --------------------------------------------------
const leadFieldMap = {
	'derived.leadLastName': 'Last_Name',
	'call.calleePhone': 'Phone',
	'derived.leadSource': 'Lead_Source',
	'call.dispositionLabel': 'Last_Call_Disposition',
	'call.dispositionNote': 'Last_Call_Note',
	'call.startedAt': 'Last_Call_Time',
	'call.dispositionScheduledAt': 'Next_Follow_up_Date_Time',
	'call.agentName': 'Last_Call_Agent',
	'derived.recordingUrl': 'Last_Call_Recording',

	// 'derived.phoneLast10': 'Phone_Last_10',
};

// --------------------------------------------------
// CONTACTS FIELD MAP (existing contacts are update-only)
// --------------------------------------------------
const contactFieldMap = {
	'call.dispositionLabel': 'Last_Call_Disposition',
	'call.dispositionNote': 'Last_Call_Note',
	'call.startedAt': 'Last_Call_Time',
	'call.dispositionScheduledAt': 'Next_Follow_up_Date_Time',
	'call.agentName': 'Last_Call_Agent',
	'derived.recordingUrl': 'Last_Call_Recording',

	// 'derived.phoneLast10': 'Phone_Last_10',
};

const leadSourceValue = '360 CallAnchor';

// Follow-up task reminder: minutes before dispositionScheduledAt (0 = at the scheduled time)
const taskReminderMinutesBefore = 15;

const ACCOUNTS_URL = process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.in';
const API_DOMAIN = process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.in';

// ==================================================
// ZOHO CRM API HELPERS
// ==================================================
let cachedToken = null;
let cachedTokenExpiry = 0;

async function getAccessToken() {
	if (cachedToken && Date.now() < cachedTokenExpiry) {
		return cachedToken;
	}

	const params = new URLSearchParams({
		refresh_token: process.env.ZOHO_REFRESH_TOKEN || '',
		client_id: process.env.ZOHO_CLIENT_ID || '',
		client_secret: process.env.ZOHO_CLIENT_SECRET || '',
		grant_type: 'refresh_token',
	});
	const resp = await fetch(`${ACCOUNTS_URL}/oauth/v2/token`, { method: 'POST', body: params });
	const json = await resp.json();
	if (!json.access_token) {
		throw new Error('Zoho token refresh failed : ' + JSON.stringify(json));
	}

	cachedToken = json.access_token;
	// Refresh a minute before the token actually expires
	cachedTokenExpiry = Date.now() + ((json.expires_in || 3600) - 60) * 1000;
	return cachedToken;
}

async function crmRequest(method, path, { query, json, form } = {}) {
	const token = await getAccessToken();
	const url = new URL(`${API_DOMAIN}/crm/v6/${path}`);
	for (const [k, v] of Object.entries(query || {})) {
		url.searchParams.set(k, v);
	}

	const headers = { Authorization: `Zoho-oauthtoken ${token}` };
	let body;
	if (json !== undefined) {
		headers['Content-Type'] = 'application/json';
		body = JSON.stringify(json);
	} else if (form !== undefined) {
		body = form;
	}

	const resp = await fetch(url, { method, headers, body });
	if (resp.status === 204) {
		return null;
	}

	const text = await resp.text();
	try {
		return JSON.parse(text);
	} catch (e) {
		return { status: resp.status, body: text };
	}
}

// Same shape as Deluge's create / update response: { id, raw } (id = '' on failure)
function recordResult(raw) {
	const first = raw && Array.isArray(raw.data) ? raw.data[0] : null;
	const id = first && first.code === 'SUCCESS' && first.details ? String(first.details.id || '') : '';
	return { id, raw };
}

async function searchRecords(module, criteria, page, perPage) {
	const raw = await crmRequest('GET', `${module}/search`, { query: { criteria, page, per_page: perPage } });
	return raw && Array.isArray(raw.data) ? raw.data : [];
}

async function createRecord(module, record) {
	return recordResult(await crmRequest('POST', module, { json: { data: [record] } }));
}

async function updateRecord(module, id, record) {
	return recordResult(await crmRequest('PUT', `${module}/${id}`, { json: { data: [record] } }));
}

async function getRelatedRecords(relation, module, id, fields) {
	const raw = await crmRequest('GET', `${module}/${id}/${relation}`, { query: { fields: fields.join(',') } });
	return raw && Array.isArray(raw.data) ? raw.data : [];
}

async function attachFile(module, id, buffer, fileName) {
	const form = new FormData();
	form.append('file', new Blob([buffer]), fileName);
	return recordResult(await crmRequest('POST', `${module}/${id}/Attachments`, { form }));
}

// ==================================================
// GENERIC HELPERS
// ==================================================
function str(value) {
	if (value === null || value === undefined) {
		return '';
	}

	return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function pad2(n) {
	return n < 10 ? '0' + n : String(n);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "2026-01-05T10:15:00.000Z" (UTC) -> Date shifted to IST, read back with getUTC*()
function utcToIst(raw) {
	const clean = raw.replace(/\.\d+Z$/, '').replace(/Z$/, '');
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(clean)) {
		throw new Error('Unparseable date : ' + raw);
	}

	const ms = Date.parse(clean + 'Z');
	if (isNaN(ms)) {
		throw new Error('Unparseable date : ' + raw);
	}

	return new Date(ms + (5 * 60 + 30) * 60 * 1000);
}

function formatIsoIst(d) {
	return `${formatDate(d)}T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}+05:30`;
}

function formatDate(d) {
	return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

// dd-MMM-yyyy hh:mm a
function formatDisplay(d) {
	const h = d.getUTCHours();
	const h12 = h % 12 === 0 ? 12 : h % 12;
	return `${pad2(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${pad2(h12)}:${pad2(d.getUTCMinutes())} ${h < 12 ? 'AM' : 'PM'}`;
}

function buildRecord(fieldMap, src, skipField) {
	const record = {};
	for (const [sourcePath, targets] of Object.entries(fieldMap)) {
		const fieldValue = src[sourcePath];
		if (fieldValue === null || fieldValue === undefined || str(fieldValue) === '') {
			continue;
		}

		for (const zohoField of targets.split(',')) {
			const fieldName = zohoField.trim();
			if (skipField && skipField(fieldName)) {
				continue;
			}

			record[fieldName] = fieldValue;
		}
	}
	return record;
}

async function readRawBody(req) {
	if (req.body !== undefined && req.body !== null) {
		return typeof req.body === 'string' || Buffer.isBuffer(req.body) ? req.body.toString() : JSON.stringify(req.body);
	}

	const chunks = [];
	for await (const chunk of req) {
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString('utf8');
}

function parseRequest(rawBody) {
	try {
		return JSON.parse(rawBody);
	} catch (e) {
		// Same clean-up the Deluge version applied to stray %22 (encoded quote) fragments
		const fixed = rawBody
			.replace(/%22"/g, '"')
			.replace(/%22,/g, '",')
			.replace(/%22}/g, '"}');
		return JSON.parse(fixed);
	}
}

// ==================================================
// MAIN WEBHOOK LOGIC
// ==================================================
async function handleWebhook(requestMap) {
	const callData = requestMap && requestMap.call;
	if (!callData || typeof callData !== 'object') {
		return 'Call object not found.';
	}

	// ==================================================
	// PHONE NORMALISATION (trim, digits only, last 10)
	// ==================================================
	const rawPhone = str(callData.calleePhone).trim();
	const phoneDigits = rawPhone.replace(/[^0-9]/g, '');
	if (phoneDigits.length < 10) {
		return 'Invalid / missing callee phone : ' + rawPhone;
	}

	const phoneLast10 = phoneDigits.slice(-10);

	// ==================================================
	// DERIVED VALUES
	// ==================================================
	const callType = str(callData.callType);
	const callId = str(callData.id);
	const agentName = str(callData.agentName);
	const agentNumber = str(callData.agentNumber);
	const calleeName = str(callData.calleeName).trim();
	const disposition = str(callData.dispositionLabel);
	const note = str(callData.dispositionNote);
	let recordingUrl = str(callData.recordingUrl);
	const isMissed = callType === 'Missed';
	const isRejected = callType === 'Rejected';
	const isMissedOrRejected = isMissed || isRejected;

	// Zoho Call_Type only has Outbound / Inbound / Missed -> Rejected is stored as Inbound,
	// and the real status (Answered / Rejected / Missed) goes into Subject + Description
	let callTypeZoho = 'Inbound';
	let callTypeLabel = callType;
	let callStatusText = '';
	let outgoingCallStatus = '';
	if (callType === 'Outgoing') {
		callTypeZoho = 'Outbound';
		callTypeLabel = 'Outbound';
		callStatusText = 'Completed';
		outgoingCallStatus = 'Completed';
	} else if (callType === 'Incoming') {
		callTypeLabel = 'Inbound';
		callStatusText = 'Answered';
	} else if (isMissed) {
		callTypeZoho = 'Missed';
		callTypeLabel = 'Missed';
		callStatusText = 'Missed';
	} else if (isRejected) {
		callTypeLabel = 'Rejected';
		callStatusText = 'Rejected';
	}

	// Duration. Missed = 0 s / 00:00, Rejected = 1 s / 00:01 placeholder, others min 1 s
	let durationText = '';
	let callDuration = '00:00';
	let durationSeconds = 0;
	if (isRejected) {
		durationSeconds = 1;
		callDuration = '00:01';
	} else if (!isMissed) {
		let dur = parseInt(str(callData.durationSeconds), 10);
		if (isNaN(dur) || dur <= 0) {
			dur = 1;
		}

		durationSeconds = dur;
		const seconds = dur % 60;
		const minutes = (dur - seconds) / 60;
		durationText = pad2(minutes) + ':' + pad2(seconds);
		callDuration = durationText;
	}

	// Subject e.g. "Interested | 00:10 | Outbound"
	const subjectParts = [];
	if (disposition !== '') {
		subjectParts.push(disposition);
	}

	if (!isRejected && durationText !== '') {
		subjectParts.push(durationText);
	}

	if (callTypeLabel !== '') {
		subjectParts.push(callTypeLabel);
	}

	const subjectText = subjectParts.length > 0 ? subjectParts.join(' | ') : 'Follow-up Call';

	if (isMissedOrRejected) {
		recordingUrl = '';
	}

	const leadLastName = calleeName !== '' ? calleeName : 'Unknown Caller ' + phoneLast10;

	// ==================================================
	// BUILD SOURCE VALUE MAP (derived + resolved paths)
	// ==================================================
	const src = {
		'derived.subject': subjectText,
		'derived.callType': callTypeZoho,
		'derived.outgoingCallStatus': outgoingCallStatus,
		'derived.callDuration': callDuration,
		'derived.callDurationSeconds': durationSeconds,
		'derived.recordingUrl': recordingUrl,
		'derived.leadLastName': leadLastName,
		'derived.leadSource': leadSourceValue,
		'derived.phoneLast10': phoneLast10,
	};

	const allKeys = [...Object.keys(callFieldMap), ...Object.keys(leadFieldMap), ...Object.keys(contactFieldMap), ...dateSourcePaths];
	for (const sourcePath of allKeys) {
		if (sourcePath.startsWith('derived.') || sourcePath in src) {
			continue;
		}

		let current = requestMap;
		let pathFound = true;
		for (const part of sourcePath.split('.')) {
			if (current !== null && typeof current === 'object' && current[part] !== null && current[part] !== undefined) {
				current = current[part];
			} else {
				pathFound = false;
				break;
			}
		}

		if (pathFound) {
			src[sourcePath] = str(current);
		}
	}

	// UTC -> IST for timestamp fields (API format + a readable copy for Description)
	let followUpDisplay = '';
	let followUpDate = '';
	let followUpRemindAt = '';
	for (const dp of dateSourcePaths) {
		const rawDate = src[dp];
		if (rawDate === undefined || rawDate === '') {
			continue;
		}

		try {
			const ist = utcToIst(rawDate);
			src[dp] = formatIsoIst(ist);
			if (dp === 'call.dispositionScheduledAt') {
				followUpDisplay = formatDisplay(ist) + ' IST';
				followUpDate = formatDate(ist);
				followUpRemindAt = formatIsoIst(new Date(ist.getTime() - taskReminderMinutesBefore * 60 * 1000));
			}
		} catch (dateEx) {
			console.log('Date conversion failed for ' + dp + ' : ' + dateEx.message);
			src[dp] = '';
		}
	}

	// Description (multi-line call note; disposition lives here instead of a picklist)
	let agentText = agentName;
	if (agentNumber !== '') {
		agentText = agentText !== '' ? agentText + ' (' + agentNumber + ')' : agentNumber;
	}

	const descLines = ['Call Type : ' + callTypeLabel];
	if (callStatusText !== '') {
		descLines.push('Call Status : ' + callStatusText);
	}

	if (callDuration !== '') {
		descLines.push('Duration : ' + callDuration + ' (' + durationSeconds + ' sec)');
	}

	if (agentText !== '') {
		descLines.push('Agent : ' + agentText);
	}

	if (calleeName !== '') {
		descLines.push('Customer : ' + calleeName);
	}

	descLines.push('Phone : ' + rawPhone);
	if (disposition !== '') {
		descLines.push('Disposition : ' + disposition);
	}

	if (note !== '') {
		descLines.push('Disposition Note : ' + note);
	}

	if (followUpDisplay !== '') {
		descLines.push('Follow-up : ' + followUpDisplay);
	}

	if (callId !== '') {
		descLines.push('Call Anchor Call ID : ' + callId);
	}

	src['derived.description'] = descLines.join('\n');

	// ==================================================
	// FIND CONTACT -> LEAD (last 10 digits match)
	// ==================================================
	let matchedId = '';
	let matchedModule = '';
	const phoneFields = ['Phone', 'Mobile'];

	// Stored formats tried on Phone / Mobile (search criteria allow max 10 conditions),
	// then the last 10 digits of each hit are verified below. Contacts are checked before Leads.
	const phoneVariants = [phoneLast10, '+91' + phoneLast10, '91' + phoneLast10, '0' + phoneLast10, '+91 ' + phoneLast10];
	const criteriaParts = [];
	for (const phoneField of phoneFields) {
		for (const variant of phoneVariants) {
			criteriaParts.push('(' + phoneField + ':equals:' + variant + ')');
		}
	}
	const phoneCriteria = '(' + criteriaParts.join(' or ') + ')';
	console.log('Phone criteria : ' + phoneCriteria);

	const candidates = [];
	for (const searchModule of ['Contacts', 'Leads']) {
		const searchResult = await searchRecords(searchModule, phoneCriteria, 1, 200);
		console.log('Search ' + searchModule + ' : ' + searchResult.length + ' result(s)');
		for (const rec of searchResult) {
			if (rec.id) {
				candidates.push({ ...rec, _module: searchModule });
			}
		}
	}

	for (const rec of candidates) {
		if (matchedId !== '') {
			break;
		}

		const recId = str(rec.id);
		if (recId === '') {
			continue;
		}

		for (const phoneField of phoneFields) {
			const recDigits = str(rec[phoneField]).replace(/[^0-9]/g, '');
			if (recDigits.length >= 10 && recDigits.slice(-10) === phoneLast10) {
				matchedId = recId;
				matchedModule = rec._module;
				break;
			}
		}
	}

	console.log('Match : ' + matchedModule + ' / ' + matchedId);

	// ==================================================
	// UPSERT PARENT (update Contact / Lead, or create Lead)
	// ==================================================
	let parentAction = '';
	if (matchedModule === 'Contacts') {
		const contactRecord = buildRecord(contactFieldMap, src);
		parentAction = 'Contact found';
		if (Object.keys(contactRecord).length > 0) {
			const contactResp = await updateRecord('Contacts', matchedId, contactRecord);
			console.log('Contact update : ' + JSON.stringify(contactResp.raw));
			if (contactResp.id === '') {
				parentAction = 'Contact found (update failed : ' + JSON.stringify(contactResp.raw) + ')';
			}
		}
	} else {
		const isNewLead = matchedId === '';
		const leadRecord = buildRecord(leadFieldMap, src, (fieldName) => !isNewLead && createOnlyFields.includes(fieldName));

		if (isNewLead) {
			let leadResp = await createRecord('Leads', leadRecord);
			console.log('Lead create : ' + JSON.stringify(leadResp.raw));

			// Lead_Source is a managed global picklist: if the value is rejected, create the lead without it
			if (leadResp.id === '' && JSON.stringify(leadResp.raw).includes('Lead_Source')) {
				delete leadRecord.Lead_Source;
				leadResp = await createRecord('Leads', leadRecord);
				console.log('Lead create (without Lead_Source) : ' + JSON.stringify(leadResp.raw));
			}

			matchedId = leadResp.id;
			if (matchedId === '') {
				return 'Lead creation failed : ' + JSON.stringify(leadResp.raw);
			}

			matchedModule = 'Leads';
			parentAction = 'Lead created';
		} else {
			parentAction = 'Lead found';
			if (Object.keys(leadRecord).length > 0) {
				const leadResp = await updateRecord('Leads', matchedId, leadRecord);
				console.log('Lead update : ' + JSON.stringify(leadResp.raw));
				if (leadResp.id === '') {
					parentAction = 'Lead found (update failed : ' + JSON.stringify(leadResp.raw) + ')';
				}
			}
		}
	}

	// ==================================================
	// BUILD CALL RECORD
	// ==================================================
	const callRecord = buildRecord(callFieldMap, src);

	// Contacts link through Who_Id, Leads through What_Id + $se_module
	if (matchedModule === 'Contacts') {
		callRecord.Who_Id = { id: matchedId };
	} else {
		callRecord.What_Id = { id: matchedId };
		callRecord.$se_module = 'Leads';
	}

	// ==================================================
	// UPSERT CALL (same call id -> update, else create)
	// ==================================================
	let existingCallId = '';
	if (callId !== '') {
		const callSearch = await searchRecords('Calls', '(' + callIdField + ':equals:' + callId + ')', 1, 1);
		if (callSearch.length > 0) {
			existingCallId = str(callSearch[0].id);
		}
	}

	let callAction = '';
	let callResp;
	if (existingCallId !== '') {
		callResp = await updateRecord('Calls', existingCallId, callRecord);
		console.log('Call update : ' + JSON.stringify(callResp.raw));
		callAction = 'Call updated';
	} else {
		callResp = await createRecord('Calls', callRecord);
		console.log('Call create : ' + JSON.stringify(callResp.raw));
		callAction = 'Call created';
	}

	const callRecordId = callResp.id;
	if (callRecordId === '') {
		return parentAction + ' (' + matchedModule + ' ' + matchedId + ') | Call save failed : ' + JSON.stringify(callResp.raw);
	}

	// ==================================================
	// ATTACH RECORDING FILE (new calls only, so repeat webhooks don't duplicate it)
	// ==================================================
	let attachAction = '';
	if (callAction === 'Call created' && recordingUrl !== '') {
		try {
			const fileResp = await fetch(recordingUrl);
			if (!fileResp.ok) {
				throw new Error('Recording download HTTP ' + fileResp.status);
			}

			const recFile = Buffer.from(await fileResp.arrayBuffer());
			const urlPath = recordingUrl.split('?')[0] || recordingUrl;
			const fileExt = urlPath.toLowerCase().endsWith('.wav') ? 'wav' : 'mp3';
			const fileName = 'Recording_' + callId + '.' + fileExt;

			// Calls may reject attachment uploads (INVALID_REQUEST_METHOD) -> fall back to the parent Lead / Contact
			const attachResp = await attachFile('Calls', callRecordId, recFile, fileName);
			console.log('Recording attach (Calls) : ' + JSON.stringify(attachResp.raw));
			if (attachResp.id !== '') {
				attachAction = ' | Recording attached to Call';
			} else {
				const parentAttachResp = await attachFile(matchedModule, matchedId, recFile, fileName);
				console.log('Recording attach (' + matchedModule + ') : ' + JSON.stringify(parentAttachResp.raw));
				if (parentAttachResp.id !== '') {
					attachAction = ' | Recording attached to ' + matchedModule;
				} else {
					attachAction = ' | Recording attach failed : Calls ' + JSON.stringify(attachResp.raw) + ' / ' + matchedModule + ' ' + JSON.stringify(parentAttachResp.raw);
				}
			}
		} catch (attachEx) {
			console.log('Recording attach failed : ' + attachEx.message);
			attachAction = ' | Recording attach failed : ' + attachEx.message;
		}
	} else {
		console.log('Recording attach skipped : callAction = ' + callAction + ', recordingUrl = ' + recordingUrl);
	}

	// ==================================================
	// FOLLOW-UP TASK (open task on the Lead / Contact when dispositionScheduledAt is sent)
	// Repeat webhooks for the same call update the existing open task instead of adding another.
	// ==================================================
	let taskAction = '';
	if (followUpDate !== '') {
		let taskSubject = 'Call Anchor Follow-up';
		if (disposition !== '') {
			taskSubject = taskSubject + ' | ' + disposition;
		}

		const taskDescLines = ['Follow-up : ' + followUpDisplay];
		if (disposition !== '') {
			taskDescLines.push('Disposition : ' + disposition);
		}

		if (note !== '') {
			taskDescLines.push('Disposition Note : ' + note);
		}

		if (agentText !== '') {
			taskDescLines.push('Agent : ' + agentText);
		}

		taskDescLines.push('Phone : ' + rawPhone);
		const callIdLine = 'Call Anchor Call ID : ' + callId;
		if (callId !== '') {
			taskDescLines.push(callIdLine);
		}

		const taskRecord = {
			Subject: taskSubject,
			Due_Date: followUpDate,
			Status: 'Not Started',
			Priority: 'High',
		};
		if (followUpRemindAt !== '') {
			taskRecord.Remind_At = { ALARM: 'FREQ=NONE;ACTION=EMAILANDPOPUP;TRIGGER=DATE-TIME:' + followUpRemindAt };
		}

		taskRecord.Description = taskDescLines.join('\n');
		if (matchedModule === 'Contacts') {
			taskRecord.Who_Id = { id: matchedId };
		} else {
			taskRecord.What_Id = { id: matchedId };
			taskRecord.$se_module = 'Leads';
		}

		let existingTaskId = '';
		if (callId !== '') {
			try {
				const relatedTasks = await getRelatedRecords('Tasks', matchedModule, matchedId, ['Status', 'Description']);
				for (const taskRec of relatedTasks) {
					if (str(taskRec.Status) !== 'Completed' && str(taskRec.Description).includes(callIdLine)) {
						existingTaskId = str(taskRec.id);
						break;
					}
				}
			} catch (taskSearchEx) {
				console.log('Related task lookup failed : ' + taskSearchEx.message);
			}
		}

		let taskResp;
		if (existingTaskId !== '') {
			taskResp = await updateRecord('Tasks', existingTaskId, taskRecord);
			console.log('Task update : ' + JSON.stringify(taskResp.raw));
			taskAction = ' | Task updated';
		} else {
			taskResp = await createRecord('Tasks', taskRecord);
			console.log('Task create : ' + JSON.stringify(taskResp.raw));
			taskAction = ' | Task created';
		}

		if (taskResp.id === '') {
			taskAction = taskAction + ' failed : ' + JSON.stringify(taskResp.raw);
		} else {
			taskAction = taskAction + ' (' + taskResp.id + ')';
		}
	}

	return parentAction + ' (' + matchedModule + ' ' + matchedId + ') | ' + callAction + ' (' + callRecordId + ')' + attachAction + taskAction;
}

// ==================================================
// HTTP ENTRY POINT (Catalyst Advanced I/O / Express-style req, res)
// Always answers 200 with a status text, like the Deluge version, so the
// webhook sender doesn't retry on business-level failures.
// ==================================================
module.exports = async (req, res) => {
	const send = (status, message) => {
		res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
		res.end(message);
	};

	try {
		let rawBody = (await readRawBody(req)).trim();
		let requestMap;
		if (rawBody !== '') {
			console.log('RAW request body : ' + rawBody);
			try {
				requestMap = parseRequest(rawBody);
			} catch (parseEx) {
				return send(200, 'Invalid JSON in request body : ' + parseEx.message + ' | RAW : ' + rawBody);
			}
		} else {
			// Fall back to query-string params (e.g. ?call={...})
			const params = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
			if (Object.keys(params).length === 0) {
				return send(200, 'Request body not found.');
			}

			requestMap = {};
			for (const [k, v] of Object.entries(params)) {
				try {
					requestMap[k] = JSON.parse(v);
				} catch (e) {
					requestMap[k] = v;
				}
			}
		}

		const result = await handleWebhook(requestMap);
		console.log('Result : ' + result);
		send(200, result);
	} catch (ex) {
		console.error('CallAnchorWebhook failed', ex);
		send(500, 'CallAnchorWebhook failed : ' + ex.message);
	}
};

module.exports.handleWebhook = handleWebhook;