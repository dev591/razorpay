"""Clears the session corpus so the instance presents as a fresh clone.

Every counter on the site is measured rather than seeded, so a demo left with
a few hundred historical sessions shows numbers a reviewer cannot account for.
Running this puts the instance back to the state a clean clone starts in.

Registered vendors are kept: they are the marketplace, not traffic, and losing
them would mean re-adding every vendor by hand before the next run.

    .venv/bin/python reset_demo.py            # asks first
    .venv/bin/python reset_demo.py --yes      # for a scripted reset

Stop the server before running this — a live process holds sessions in memory
and will write some of them back on its next persist.
"""

import argparse
import glob
import os
import sqlite3

from config import AUDIT_DIR, DB_PATH, SESSIONS_DIR


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--yes", action="store_true", help="skip the confirmation")
    args = parser.parse_args()

    con = sqlite3.connect(DB_PATH)
    sessions = con.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
    vendors = con.execute("SELECT COUNT(*) FROM businesses").fetchone()[0]
    ledgers = glob.glob(str(AUDIT_DIR / "*.jsonl"))
    files = glob.glob(str(SESSIONS_DIR / "*.json"))

    print(f"  {sessions} sessions, {len(ledgers)} audit ledgers, {len(files)} session files")
    print(f"  {vendors} registered vendors will be kept")

    if not (sessions or ledgers or files):
        print("Already clean.")
        con.close()
        return

    if not args.yes:
        # The audit ledgers are the only copy of what those negotiations did.
        if input("Delete them permanently? [y/N] ").strip().lower() not in ("y", "yes"):
            print("Left untouched.")
            con.close()
            return

    con.execute("DELETE FROM sessions")
    con.commit()
    con.execute("VACUUM")
    con.close()
    for path in ledgers + files:
        os.remove(path)

    print(f"Cleared {sessions} sessions and {len(ledgers)} ledgers. Restart the server.")


if __name__ == "__main__":
    main()
