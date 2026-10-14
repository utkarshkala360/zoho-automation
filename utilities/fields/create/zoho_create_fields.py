#!/usr/bin/env python3
"""
Zoho CRM bulk custom-field creator.

Reuses the credentials, data centre, token cache and sandbox/production switch
from ../export/zoho_export_fields.py, so there is nothing extra to configure.

    python3 zoho_create_fields.py --env sandbox --dry-run    # preview only, creates nothing
    python3 zoho_create_fields.py --env sandbox
    python3 zoho_create_fields.py --env production            # asks for confirmation

Behaviour:
  - Fields that already exist (same API name or same label) are skipped, so it is safe to re-run.
  - Zoho builds the API name from the label; after creating, the script re-reads the
    module and confirms each field got the expected API name.
  - New fields are given read/write access for every profile in the org.

Token scopes needed: ZohoCRM.settings.fields.ALL, ZohoCRM.settings.profiles.READ
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "export"))
import zoho_export_fields as zoho  # noqa: E402

# ==================================================
# FIELDS TO CREATE   (module -> list of definitions)
# ==================================================
# type: text | phone | textarea | datetime | integer | website | boolean
FIELDS = {
    "Calls": [
        {"label": "Call Anchor Call Id", "api_name": "Call_Anchor_Call_Id", "type": "text", "length": 255, "unique": True},
        {"label": "Agent Name", "api_name": "Agent_Name", "type": "text", "length": 255},
        {"label": "Callee Name", "api_name": "Callee_Name", "type": "text", "length": 255},
        # Calls does not support the phone type -> plain text
        {"label": "Agent Number", "api_name": "Agent_Number", "type": "text", "length": 50},
        {"label": "Callee Phone Number", "api_name": "Callee_Phone_Number", "type": "text", "length": 50},
        {"label": "Disposition", "api_name": "Disposition", "type": "text", "length": 255},
        # Calls only allows small (2000-char) text areas
        {"label": "Disposition Note", "api_name": "Disposition_Note", "type": "textarea", "length": 2000, "textarea_type": "small"},
        {"label": "Follow up Date Time", "api_name": "Follow_up_Date_Time", "type": "datetime"},
    ],
}


# ==================================================
# HELPERS
# ==================================================
def get_profiles():
    try:
        profiles = zoho.api_get("settings/profiles").get("profiles", [])
        return [{"id": p["id"], "permission_type": "read_write"} for p in profiles]
    except RuntimeError as e:
        print(f"  ! Could not read profiles, Zoho defaults will apply : {e.args[0].splitlines()[0]}")
        return []


def existing_fields(module):
    fields = zoho.api_get("settings/fields", {"module": module}).get("fields", [])
    return {f["api_name"].lower(): f for f in fields}, {f["field_label"].lower(): f for f in fields}


def build_payload(defn, profiles, minimal=False):
    field = {"field_label": defn["label"], "data_type": defn["type"]}
    if defn.get("length"):
        field["length"] = defn["length"]
    if defn["type"] == "textarea":
        field["textarea"] = {"type": defn.get("textarea_type", "large")}
    if profiles:
        field["profiles"] = profiles
    if defn.get("unique") and not minimal:
        field["unique"] = {"casesensitive": False}
    return {"fields": [field]}


def create_field(module, defn, profiles):
    payload = build_payload(defn, profiles)
    try:
        return zoho.api_request("POST", "settings/fields", {"module": module}, payload), True
    except RuntimeError as e:
        if not defn.get("unique"):
            raise
        # Some orgs / API versions reject the unique flag -> create without it and say so
        print(f"    ! Unique flag rejected, retrying without it ({e.args[0].splitlines()[0]})")
        payload = build_payload(defn, profiles, minimal=True)
        return zoho.api_request("POST", "settings/fields", {"module": module}, payload), False


# ==================================================
# MAIN
# ==================================================
def main():
    zoho.apply_env_arg()
    dry_run = "--dry-run" in sys.argv
    env = zoho.env_name()
    print(f"Org : {env}{'  (DRY RUN - nothing will be created)' if dry_run else ''}")

    if env == "production" and not dry_run and "--yes" not in sys.argv:
        answer = input("Create fields in PRODUCTION? Type 'yes' to continue: ").strip().lower()
        if answer != "yes":
            sys.exit("Aborted.")

    profiles = [] if dry_run else get_profiles()
    summary = {"created": 0, "skipped": 0, "failed": 0, "name_mismatch": 0}

    for module, defs in FIELDS.items():
        print(f"\n== {module} ==")
        by_api, by_label = existing_fields(module)
        created = []

        for defn in defs:
            match = by_api.get(defn["api_name"].lower()) or by_label.get(defn["label"].lower())
            if match:
                print(f"  = {defn['api_name']:28} exists ({match['api_name']}, {match['data_type']}) - skipped")
                summary["skipped"] += 1
                continue

            if dry_run:
                print(f"  + {defn['api_name']:28} would be created : {build_payload(defn, profiles)['fields'][0]}")
                continue

            try:
                resp, unique_applied = create_field(module, defn, profiles)
                result = (resp.get("fields") or [{}])[0]
                if result.get("status") == "success":
                    note = "" if unique_applied or not defn.get("unique") else "  (NOT unique - set it in Zoho UI)"
                    print(f"  ✓ {defn['api_name']:28} created{note}")
                    summary["created"] += 1
                    created.append(defn)
                else:
                    print(f"  ✗ {defn['api_name']:28} failed : {result}")
                    summary["failed"] += 1
            except RuntimeError as e:
                print(f"  ✗ {defn['api_name']:28} failed : {e}")
                summary["failed"] += 1

        # Confirm Zoho generated the API names the Deluge function expects
        if created:
            by_api_after, by_label_after = existing_fields(module)
            for defn in created:
                if defn["api_name"].lower() not in by_api_after:
                    actual = by_label_after.get(defn["label"].lower(), {}).get("api_name", "?")
                    print(f"  ! {defn['label']} was created as '{actual}', expected '{defn['api_name']}' - rename it in Zoho")
                    summary["name_mismatch"] += 1

    print(f"\nDone ({env}). Created {summary['created']}, skipped {summary['skipped']}, "
          f"failed {summary['failed']}, API-name mismatches {summary['name_mismatch']}.")


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as e:
        sys.exit(f"ERROR: {e}")
