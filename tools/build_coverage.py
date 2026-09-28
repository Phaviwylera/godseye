"""Build an honest, credential-free catalogue summary; never claim indexed = live."""
import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def summarize(features, registry, health):
    providers = {x['id']: x for x in registry.get('sources', [])}
    buckets = {}
    for f in features:
        p = f.get('properties', {})
        key = p.get('src', p.get('source', 'unknown'))
        b = buckets.setdefault(key, {'indexed': 0, 'types': Counter(), 'countries': set(),
                                      'last_probe_success': 0, 'last_probe_failure': 0, 'unprobed': 0})
        b['indexed'] += 1
        b['types'][p.get('stype', 'unknown')] += 1
        if p.get('country'): b['countries'].add(p['country'])
        value = health.get('s', {}).get(p.get('id'))
        b['last_probe_success' if value == 1 else 'last_probe_failure' if value == 0 else 'unprobed'] += 1
    rows = []
    for key, b in sorted(buckets.items()):
        provider = providers.get(key, {})
        rows.append({'id': key, 'name': provider.get('name', key),
                     'page': provider.get('page', ''), 'attribution': provider.get('attribution', ''),
                     **b, 'types': dict(b['types']), 'countries': sorted(b['countries'])})
    return {'indexed': len(features), 'probe_generated': health.get('generated'),
            'note': 'Indexed records are not verified working streams. Probe results are historical, not current availability. Video, snapshots and external pages are separate types.',
            'sources': rows}


def main():
    def read(name):
        return json.loads((ROOT / 'data' / name).read_text())
    index = read('cameras.index.json')
    features = [{'properties': {'id': c['id'], 'src': c['s'], 'stype': c['t'], 'country': c.get('c')}} for c in index['cams']]
    report = summarize(features, read('sources.json'), read('liveness.json'))
    report['generated'] = datetime.now(timezone.utc).isoformat()
    (ROOT / 'data' / 'coverage.json').write_text(json.dumps(report, indent=2) + '\n')
    print(f"Coverage: {report['indexed']} indexed records, {len(report['sources'])} source groups")


if __name__ == '__main__':
    main()
