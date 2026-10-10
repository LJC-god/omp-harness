"""Read-only, advisory OMP project-root preflight. Never acquires or clears locks."""

import argparse
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import time

DEFAULT_DB = Path('~/.omp/agent/orchestration.sqlite').expanduser()


def canonical(value):
    return os.path.normcase(str(Path(value).resolve()))


def contains(parent, child):
    return child == parent or child.startswith(parent.rstrip(os.sep) + os.sep)


def overlaps(left, right):
    return contains(left, right) or contains(right, left)


def inspect(root, db_path=DEFAULT_DB):
    requested = Path(root).absolute()
    target = canonical(requested)
    result = {
        'requestedRoot': str(requested), 'resolvedRoot': target,
        'readOnly': True, 'advisoryOnly': True, 'reasons': [],
        'registeredAncestors': [], 'registeredDescendants': [], 'exactProject': None,
        'gitRoot': None, 'workspaceWriters': [], 'unsettledTasks': [], 'liveLeases': [],
        'errors': [],
    }
    if Path(target).drive.lower() != 'd:':
        result['reasons'].append('UNSUPPORTED_PROJECT_DRIVE')
    if requested.exists() and not requested.is_dir():
        result['errors'].append('Requested project root is not a directory.')
    existing = Path(target)
    while not existing.exists() and existing != existing.parent:
        existing = existing.parent
    if not existing.is_dir():
        result['errors'].append('No existing directory available for Git-root inspection.')
    else:
        try:
            proc = subprocess.run(
                ['git', '-C', str(existing), 'rev-parse', '--show-toplevel'],
                capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=10,
                env={**os.environ, 'GIT_OPTIONAL_LOCKS': '0'},
            )
            if proc.returncode == 0:
                result['gitRoot'] = canonical(proc.stdout.strip())
                if result['gitRoot'] != target:
                    result['reasons'].append('SHARED_GIT_ROOT')
            elif 'not a git repository' not in proc.stderr.lower():
                result['errors'].append('Git-root inspection failed; inspect the selected root and Git environment.')
        except (OSError, subprocess.TimeoutExpired):
            result['errors'].append('Git-root inspection unavailable or timed out.')
    workspace_root = result['gitRoot'] or target
    result['effectiveWorkspaceRoot'] = workspace_root
    db = None
    try:
        db = sqlite3.connect(Path(db_path).resolve().as_uri() + '?mode=ro', uri=True, timeout=3)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA query_only=ON')
        projects = list(db.execute('SELECT id,canonical_root,root_vol FROM projects'))
        for project in projects:
            registered = canonical(project['canonical_root'])
            item = {'projectId': project['id'], 'root': project['canonical_root']}
            if registered == target:
                result['exactProject'] = item
                if project['root_vol'] is None or project['root_vol'] < 0:
                    result['reasons'].append('ROOT_IDENTITY_REQUIRES_INSPECTION')
            elif contains(registered, target):
                result['registeredAncestors'].append(item)
            elif contains(target, registered):
                result['registeredDescendants'].append(item)
            if not overlaps(registered, workspace_root):
                continue
            for row in db.execute("SELECT task_key,state FROM control_tasks WHERE project_id=? AND state IN ('running','interrupted')", (project['id'],)):
                result['unsettledTasks'].append({**item, 'task': row['task_key'], 'state': row['state']})
            for row in db.execute('SELECT l.resource,l.owner,l.expires_at FROM leases l JOIN generations g ON g.project_id=l.project_id AND g.value=l.generation WHERE l.project_id=? AND l.expires_at>?', (project['id'], int(time.time() * 1000))):
                result['liveLeases'].append({**item, 'resource': row['resource'], 'owner': row['owner'], 'expiresAt': row['expires_at']})
        for row in db.execute('SELECT root,owner,runtime_pid FROM workspace_activity'):
            if overlaps(canonical(row['root']), workspace_root):
                result['workspaceWriters'].append({'root': row['root'], 'owner': row['owner'], 'pid': row['runtime_pid']})
    except (OSError, sqlite3.Error):
        result['errors'].append('Control database is unavailable or its schema could not be inspected read-only.')
    finally:
        if db is not None:
            db.close()
    if result['registeredAncestors'] or result['registeredDescendants']:
        result['reasons'].append('REGISTRATION_OVERLAP')
    if result['workspaceWriters'] or result['unsettledTasks'] or result['liveLeases']:
        result['reasons'].append('OCCUPANCY_REQUIRES_INSPECTION')
    if result['errors']:
        result['reasons'].append('UNKNOWN')
    result['status'] = 'CHECK_REQUIRED' if result['reasons'] else 'NO_CONFLICT_OBSERVED'
    result['nextAction'] = (
        'Inspect the named registration/Git/occupancy issue through existing native controls; do not unlock, relocate or initialize Git based on this report.'
        if result['reasons'] else
        'Proceed through native project_get/workspace_prepare and ownership checks for this exact root; this snapshot does not reserve it or authorize writes.'
    )
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True)
    parser.add_argument('--db', type=Path, default=DEFAULT_DB, help='Read-only database path; override for isolated tests only.')
    args = parser.parse_args()
    report = inspect(args.root, args.db)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    raise SystemExit(0 if report['status'] == 'NO_CONFLICT_OBSERVED' else 2)
