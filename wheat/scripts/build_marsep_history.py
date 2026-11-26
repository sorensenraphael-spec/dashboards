"""Build genuine Mar(Y)/Sep(Y) history from the supplied Edge workbook.

Usage: python build_marsep_history.py WORKBOOK OUTPUT_JSON
November contracts are deliberately excluded. No price forward filling.
"""
import datetime as dt
import hashlib
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

from openpyxl import load_workbook


def build(path):
    workbook = load_workbook(path, read_only=True, data_only=True)
    source = workbook['Daily_long'].iter_rows(values_only=True)
    header = next(source)
    required = {'date', 'contract', 'month', 'year', 'settle'}
    assert required <= set(header), 'Unexpected workbook schema'
    rows, contracts = {}, {}
    for values in source:
        row = dict(zip(header, values))
        if row['month'] not in ('Mar', 'Sep'):
            continue
        date = row['date'].date().isoformat()
        year = int(row['year'])
        price = float(row['settle'])
        assert math.isfinite(price) and price > 0
        key = (row['month'], year, date)
        assert key not in rows, ('Duplicate settlement', key)
        identity = (row['month'], year)
        assert contracts.get(identity, row['contract']) == row['contract']
        contracts[identity] = row['contract']
        rows[key] = price
    groups = defaultdict(list)
    for (month, year, date), dec in sorted(rows.items()):
        if month != 'Mar' or not f'{year-1}-04-01' <= date < f'{year}-03-01':
            continue
        mar = rows.get(('Sep', year, date))
        if mar is not None:
            groups[year].append([date, dec, mar])
    assert groups, 'No matched March/September history'
    series = [{'year': year, 'marchContract': contracts['Mar', year],
               'septemberContract': contracts['Sep', year], 'points': sorted(points)}
              for year, points in sorted(groups.items())]
    return {
        'schemaVersion': 1,
        'source': 'User-supplied Edge Euronext/MATIF settlement workbook',
        'workbook': path.name,
        'workbookSha256': hashlib.sha256(path.read_bytes()).hexdigest(),
        'units': 'EUR per tonne',
        'pointColumns': ['date', 'marchSettlement', 'septemberSettlement'],
        'method': 'Same-date March(Y) minus September(Y), April(Y-1) through February(Y). Missing September 2008-2014 stays missing. Recent Euronext observations override overlapping workbook dates.',
        'series': series,
    }


if __name__ == '__main__':
    source, target = map(Path, sys.argv[1:])
    payload = build(source)
    target.write_text(json.dumps(payload, separators=(',', ':'), allow_nan=False)+'\n', encoding='utf-8')
    print(json.dumps([{'year': s['year'], 'count': len(s['points']),
                       'first': s['points'][0][0], 'last': s['points'][-1][0]}
                      for s in payload['series']]))
