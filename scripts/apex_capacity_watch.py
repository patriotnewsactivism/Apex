#!/usr/bin/env python3
"""Read-only, zero-inference APEX capacity observation. Never resets quotas or changes accounts.

Run hourly with the Hermes no_agent scheduler for 72 repeats. Reads the live
container's admin token in memory; persists only selected operational counters.
--self-test exercises synthetic fixtures only and never contacts production.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.request

ROOT = Path('/home/hermes/Operations/APEX/capacity-watch')
UTC = dt.timezone.utc


def summarize(health: dict, spend: dict, autonomy: dict) -> dict:
    capacity = health.get('llmCapacity', {})
    providers = capacity.get('providers', [])
    active = [p for p in providers if p.get('enabled')]
    cap = float(spend.get('capUsd') or 0)
    used = float(spend.get('spentUsd') or 0)
    available = any(p.get('available') for p in active) if providers else capacity.get('state') in ('available', 'paced')
    tasks = autonomy.get('tasks', {})
    completed = autonomy.get('throughput', {}).get('lastHour', {}).get('completed', 0)
    pending = tasks.get('pending', 0)
    level = 'critical' if not available or (pending > 0 and completed == 0) else 'warning' if cap > 0 and used / cap >= 0.8 else 'ok'
    return {
        'at': dt.datetime.now(UTC).isoformat(), 'day': spend.get('day'),
        'buildSha': health.get('build', {}).get('sha'),
        'capacityState': capacity.get('state'), 'level': level,
        'anyRouteAvailable': available, 'spentUsd': used, 'capUsd': cap,
        'budgetUtilizationPct': round(used / cap * 100, 1) if cap else None,
        'reservedUsd': spend.get('reservedUsd'),
        'priorityReserveUsd': spend.get('priorityReserveUsd'),
        'allProviderRequests': spend.get('requests', {}).get('allProviderUsed'),
        'completedLastHour': completed, 'pending': pending,
        'blocked': tasks.get('blocked', 0), 'retryBacklog': tasks.get('retryBacklog', 0),
        'providers': [{k: p.get(k) for k in ('name', 'state', 'available', 'resumeAt', 'lastSuccessAt')} for p in active],
    }


def counter_delta(previous: dict, current: dict) -> dict:
    if previous.get('day') != current.get('day'):
        return {'sameDay': False, 'spendDeltaUsd': None, 'requestDelta': None}
    spend = current['spentUsd'] - previous['spentUsd']
    requests = current.get('allProviderRequests')
    old_requests = previous.get('allProviderRequests')
    return {'sameDay': True,
            'spendDeltaUsd': round(spend, 6) if spend >= 0 else None,
            'requestDelta': requests - old_requests if isinstance(requests, int) and isinstance(old_requests, int) and requests >= old_requests else None}


def alert_key(record: dict) -> tuple:
    pct = record.get('budgetUtilizationPct') or 0
    band = 100 if pct >= 100 else 90 if pct >= 90 else 80 if pct >= 80 else 0
    return (record.get('day'), record['level'], record['anyRouteAvailable'], band,
            tuple(sorted((p['name'], p['state']) for p in record['providers'] if p['state'] in ('access_denied', 'upstream_quota'))))


def collect() -> tuple[dict, dict, dict]:
    result = subprocess.run(['sudo', '-n', 'docker', 'inspect', 'apex-contabo-apex-1'],
                            capture_output=True, check=True, text=True, timeout=15)
    env = dict(item.split('=', 1) for item in json.loads(result.stdout)[0]['Config']['Env'] if '=' in item)
    token = env['APEX_ADMIN_TOKEN']
    def get(path: str) -> dict:
        req = urllib.request.Request('https://apexwork.org' + path, headers={'Authorization': 'Bearer ' + token})
        with urllib.request.urlopen(req, timeout=25) as response:
            return json.load(response)
    return get('/api/health/detail'), get('/api/spend'), get('/api/autonomy')


def run() -> None:
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(ROOT, 0o700)
    history = ROOT / 'samples.jsonl'
    rows = [json.loads(line) for line in history.read_text().splitlines()] if history.exists() else []
    if rows and (dt.datetime.now(UTC) - dt.datetime.fromisoformat(rows[0]['at'])).total_seconds() > 73 * 3600:
        return  # Bounded observation, even if a scheduler misfires after its repeat limit.
    record = summarize(*collect())
    record['delta'] = counter_delta(rows[-1], record) if rows else None
    with history.open('a') as stream:
        stream.write(json.dumps(record, sort_keys=True) + '\n')
    os.chmod(history, 0o600)
    (ROOT / 'latest.json').write_text(json.dumps(record, indent=2) + '\n')
    os.chmod(ROOT / 'latest.json', 0o600)
    changed = not rows or alert_key(rows[-1]) != alert_key(record)
    if changed and (record['level'] != 'ok' or (rows and rows[-1]['level'] != 'ok')):
        print(f"APEX capacity {record['level'].upper()}: {record['capacityState']}; "
              f"paid ledger ${record['spentUsd']:.4f}/${record['capUsd']:.2f}; "
              f"completed last hour={record['completedLastHour']}, pending={record['pending']}. "
              f"Provider states: {', '.join(p['name'] + '=' + str(p['state']) for p in record['providers'])}. "
              'Read-only observation; no quotas reset or spending changed.')
    # The initial manual sample plus 72 hourly ticks spans a full 72 hours.
    if len(rows) == 72:
        all_rows = rows + [record]
        elapsed = (dt.datetime.fromisoformat(record['at']) - dt.datetime.fromisoformat(rows[0]['at'])).total_seconds() / 3600
        print(f"APEX capacity observation finished: {len(all_rows)} samples spanning {elapsed:.1f} hours; "
              f"{sum(not r['anyRouteAvailable'] for r in all_rows)} samples with no route admitted; "
              f"{sum(r['pending'] > 0 and r['completedLastHour'] == 0 for r in all_rows)} samples with pending work and zero completions in their preceding hour. "
              f"Evidence: {history}. This is sampled evidence, not proof of uninterrupted uptime.")


def self_test() -> None:
    import unittest
    class Tests(unittest.TestCase):
        def test_healthy(self):
            r = summarize({'llmCapacity': {'state': 'available', 'providers': [{'name': 'free', 'enabled': True, 'available': True, 'state': 'available'}]}}, {'day': 'test', 'capUsd': 2, 'spentUsd': 0.2}, {'tasks': {'pending': 2}, 'throughput': {'lastHour': {'completed': 4}}})
            self.assertEqual(r['level'], 'ok')
        def test_false_healthy(self):
            r = summarize({'llmCapacity': {'state': 'available', 'providers': [{'enabled': True, 'available': False}]}}, {'capUsd': 2, 'spentUsd': 1.99}, {})
            self.assertEqual(r['level'], 'critical')
        def test_stall(self):
            r = summarize({'llmCapacity': {'state': 'available'}}, {'capUsd': 2, 'spentUsd': 0.1}, {'tasks': {'pending': 1}})
            self.assertEqual(r['level'], 'critical')
        def test_rollover(self):
            self.assertEqual(counter_delta({'day': 'one'}, {'day': 'two'})['spendDeltaUsd'], None)
        def test_deltas(self):
            self.assertEqual(counter_delta({'day': 'one', 'spentUsd': 0.1, 'allProviderRequests': 10}, {'day': 'one', 'spentUsd': 0.3, 'allProviderRequests': 12})['requestDelta'], 2)
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Tests))
    if not result.wasSuccessful():
        raise SystemExit(1)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args()
    if args.self_test:
        self_test()
    else:
        try:
            run()
        except Exception as exc:
            # Never echo command stdout/stderr or request headers; they can contain credentials.
            print('APEX capacity observation failed: ' + type(exc).__name__ + '. No state was changed; inspect the local service health.')
            sys.exit(1)
