#!/usr/bin/env python3
"""Build the descriptive March-wheat dashboard bundle from actual daily data.

Default sources live in data/source. Optional US imports may use the three-column
template (date,delivery_year,settle_cents_bu), or the paired Norgate extractor's
date,market,contract,month,year,settle,volume,open_interest schema. This script does
not retrieve quotes, create proxy prices, or forward-fill either futures leg.
"""
from __future__ import annotations

import argparse
import bisect
import csv
from datetime import date, datetime, timezone
from decimal import Decimal, localcontext
import hashlib
import json
from pathlib import Path
import re
import shutil

PROJECT = Path(__file__).resolve().parents[1]
BU_PER_TONNE = Decimal(1000) / (Decimal(60) * Decimal('0.45359237'))
FX_MAX_AGE_DAYS = 3
US_NAMES = {'cbot': ('CBOT', 'Chicago SRW wheat', 'ZW'),
            'kc': ('KC', 'Kansas City HRW wheat', 'KE')}
CSV_IMPORT_HEADER = ['date', 'delivery_year', 'settle_cents_bu']
SOURCE_NAMES = ['matif_march_contracts.csv', 'eurusd_ecb.csv',
                'cbot_march.csv', 'kc_march.csv', 'cbot_march_daily.csv',
                'kc_march_daily.csv', 'us_wheat_march_daily.csv']


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def number(value, *, required=True):
    if value is None or str(value).strip() == '':
        if required:
            raise ValueError('Required numeric value is missing')
        return None
    result = Decimal(str(value).strip())
    if not result.is_finite():
        raise ValueError(f'Non-finite numeric value: {value!r}')
    return result


def iso_day(value) -> date:
    text = str(value).strip()
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}(?:[ T]00:00:00(?:\.0+)?)?', text):
        raise ValueError(f'Expected an ISO daily observation date, got {value!r}')
    return date.fromisoformat(text[:10])


def read_csv(path: Path):
    with path.open(newline='', encoding='utf-8-sig') as stream:
        return list(csv.DictReader(stream))


def write_csv(path: Path, columns, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('w', newline='', encoding='utf-8') as stream:
        writer = csv.DictWriter(stream, fieldnames=columns, extrasaction='ignore')
        writer.writeheader()
        writer.writerows(rows)


def serial_number(value):
    if value is None:
        return None
    return int(value) if value == value.to_integral_value() else float(value)


class FX:
    """Latest actual ECB observation on/before the price date, age <=3 days."""
    def __init__(self, path: Path, as_of: date):
        values = {}
        for row in read_csv(path):
            day = iso_day(row['date'])
            rate = number(row['eurusd_usd_per_eur'])
            if rate <= 0:
                raise ValueError(f'Non-positive EURUSD on {day}')
            if day in values:
                raise ValueError(f'Duplicate EURUSD observation on {day}')
            if day <= as_of:
                values[day] = rate
        self.days = sorted(values)
        self.values = values
        if not self.days:
            raise ValueError('No eligible EURUSD observations')

    def at(self, day: date):
        i = bisect.bisect_right(self.days, day) - 1
        if i < 0:
            return None, None, None
        observed = self.days[i]
        age = (day - observed).days
        if age > FX_MAX_AGE_DAYS:
            return None, None, None
        return self.values[observed], observed, age


def in_season(day: date, delivery_year: int):
    return date(delivery_year - 1, 4, 1) <= day < date(delivery_year, 3, 1)


def point(day, year, native, fx, *, market, volume=None, oi=None):
    rate, fxday, age = fx.at(day)
    with localcontext() as ctx:
        ctx.prec = 40
        if market == 'matif':
            eurt = native
            usdt = native * rate if rate is not None else None
        else:
            usdt = native / Decimal(100) * BU_PER_TONNE
            eurt = usdt / rate if rate is not None else None
    return {'date': day.isoformat(), 'seasonDay': (day - date(year - 1, 4, 1)).days,
            'eurt': float(eurt) if eurt is not None else None,
            'usdt': float(usdt) if usdt is not None else None,
            'fx': float(rate) if rate is not None else None,
            'fxdate': fxday.isoformat() if fxday else None, 'fxAgeDays': age,
            'volume': serial_number(volume), 'openInterest': serial_number(oi),
            **({'settleCentsBu': float(native)} if market != 'matif' else {})}


def group_points(rows):
    grouped = {}
    for year, contract, item in rows:
        entry = grouped.setdefault(year, {'year': year, 'contract': contract, 'points': []})
        if entry['contract'] != contract:
            raise ValueError(f'Multiple March contracts for delivery year {year}')
        entry['points'].append(item)
    for entry in grouped.values():
        entry['points'].sort(key=lambda p: p['date'])
        days = [p['date'] for p in entry['points']]
        if len(days) != len(set(days)):
            raise ValueError(f'Duplicate futures observations in year {entry["year"]}')
    return [grouped[year] for year in sorted(grouped)]


def load_matif(path, fx, as_of):
    selected = []
    seen = set()
    for row in read_csv(path):
        day = iso_day(row['date']); year = int(row['delivery_year'])
        contract = row['contract'].strip(); settle = number(row['matif_eur_t'])
        if contract != f'MLH{year % 100:02d}' or row.get('month', 'Mar') != 'Mar':
            raise ValueError(f'Not a matching MATIF March contract: {contract}, {year}')
        if settle <= 0:
            raise ValueError(f'Non-positive MATIF settlement on {day}')
        key = year, day
        if key in seen:
            raise ValueError(f'Duplicate MATIF observation: {key}')
        seen.add(key)
        if day > as_of or not in_season(day, year):
            continue
        selected.append((year, contract, point(day, year, settle, fx, market='matif',
                        volume=number(row.get('volume'), required=False),
                        oi=number(row.get('open_interest'), required=False))))
    return group_points(selected)


def load_us(market, source, fx, as_of):
    label, _, root = US_NAMES[market]
    paths = [source / f'{market}_march.csv', source / f'{market}_march_daily.csv',
             source / 'us_wheat_march_daily.csv']
    observations = {}; used = []
    for path in paths:
        if not path.exists():
            continue
        rows = read_csv(path)
        if not rows:
            continue
        used.append(path)
        for row in rows:
            combined = path.name == 'us_wheat_march_daily.csv'
            if combined and not str(row.get('market') or '').strip():
                raise ValueError('Combined US wheat input requires an explicit CBOT/ZW or KC/KE market on every row')
            row_market = (row.get('market') or label).strip().upper()
            if row_market not in ['CBOT', 'ZW', 'KC', 'KE']:
                raise ValueError(f'Unknown US wheat market {row_market} in {path.name}')
            if row_market not in [label, root]:
                if combined:
                    continue
                raise ValueError(f'Unexpected market {row_market} in {path.name}')
            year_text = row.get('delivery_year') or row.get('year')
            year = int(year_text)
            if not 1900 <= year <= 2200:
                raise ValueError(f'Invalid delivery year {year}')
            month = str(row.get('month') or '3').strip().lower()
            if month not in ['3', '3.0', '03', 'mar', 'march', 'h']:
                raise ValueError(f'Only March observations are accepted: {month}')
            contract = (row.get('contract') or f'{root}-{year}H').strip()
            if contract != f'{root}-{year}H':
                raise ValueError(f'Contract/year mismatch: {contract}, {year}')
            day = iso_day(row['date'])
            settle = number(row.get('settle_cents_bu') or row.get('settle'))
            if settle <= 0:
                raise ValueError(f'Non-positive {label} settlement on {day}')
            value = (contract, settle, number(row.get('volume'), required=False),
                     number(row.get('open_interest'), required=False))
            key = year, day
            if key in observations:
                previous = observations[key]
                if previous[:2] != value[:2]:
                    raise ValueError(f'Conflicting {label} observations for {key}')
                value = (contract, settle, value[2] if value[2] is not None else previous[2],
                         value[3] if value[3] is not None else previous[3])
            observations[key] = value
    selected = []
    for (year, day), (contract, settle, volume, oi) in sorted(observations.items()):
        if day <= as_of and in_season(day, year):
            selected.append((year, contract, point(day, year, settle, fx, market=market,
                                                  volume=volume, oi=oi)))
    return group_points(selected), used


def spreads(matif, us):
    """Exact observation date and delivery-year inner join, never an as-of future join."""
    other = {s['year']: s for s in us}; result = []
    for m in matif:
        if m['year'] not in other:
            continue
        u = other[m['year']]; bydate = {p['date']: p for p in u['points']}; points = []
        for mp in m['points']:
            up = bydate.get(mp['date'])
            if up is None or mp['fx'] is None:
                continue
            assert mp['fxdate'] == up['fxdate']
            points.append({'date': mp['date'], 'seasonDay': mp['seasonDay'],
                           'eurt': mp['eurt'] - up['eurt'], 'usdt': mp['usdt'] - up['usdt'],
                           'fx': mp['fx'], 'fxdate': mp['fxdate'], 'fxAgeDays': mp['fxAgeDays'],
                           'volume': None, 'openInterest': None,
                           'matifVolume': mp['volume'], 'usVolume': up['volume']})
        if points:
            result.append({'year': m['year'], 'contract': f'{m["contract"]} − {u["contract"]}',
                           'matifContract': m['contract'], 'usContract': u['contract'], 'points': points})
    return result


def coverage(series, market, current_year):
    rows = []
    for s in series:
        p = s['points']; year = s['year']; first = iso_day(p[0]['date']); last = iso_day(p[-1]['date'])
        past = year < current_year
        months = {(iso_day(x['date']).year, iso_day(x['date']).month) for x in p}
        complete = (past and first <= date(year - 1, 4, 15) and last >= date(year, 2, 15)
                    and len(p) >= 150 and len(months) == 11)
        volume_points = [x for x in p if x['volume'] is not None]
        rows.append({'market': market, 'year': year, 'contract': s['contract'], 'observations': len(p),
                     'firstDate': p[0]['date'], 'lastDate': p[-1]['date'],
                     'firstSeasonDay': p[0]['seasonDay'], 'lastSeasonDay': p[-1]['seasonDay'],
                     'monthsObserved': len(months),
                     'maximumCalendarGapDays': max(((iso_day(b['date'])-iso_day(a['date'])).days
                                                    for a,b in zip(p,p[1:])), default=0),
                     'isCurrent': year == current_year, 'isPartial': not complete,
                     'isComparable': complete, 'missingFx': sum(x['fx'] is None for x in p),
                     'carriedFx': sum(x['fxAgeDays'] is not None and x['fxAgeDays'] > 0 for x in p),
                     'maximumFxAgeDays': max((x['fxAgeDays'] or 0 for x in p), default=0),
                     'zeroVolumeFraction': (sum(x['volume'] == 0 for x in volume_points) / len(volume_points)
                                            if volume_points else None),
                     'totalVolume': sum(x['volume'] for x in volume_points) if volume_points else None,
                     'peakOpenInterest': max((x['openInterest'] for x in p if x['openInterest'] is not None), default=None)})
    return rows


def latest(series, year):
    eligible = [s for s in series if s['year'] == year and s['points']]
    if not eligible:
        return None
    s = eligible[0]; p = s['points']; result = dict(p[-1], year=year, contract=s['contract'])
    if len(p) > 1:
        result['previousDate'] = p[-2]['date']
        for unit in ['eurt', 'usdt']:
            result[f'change{unit.capitalize()}'] = (float(Decimal(str(p[-1][unit])) - Decimal(str(p[-2][unit])))
                                                   if p[-1][unit] is not None and p[-2][unit] is not None else None)
    return result


def build(source: Path, output: Path, as_of: date):
    output.mkdir(parents=True, exist_ok=True); downloads = output / 'downloads'; downloads.mkdir(exist_ok=True)
    fx_path = source / 'eurusd_ecb.csv'; matif_path = source / 'matif_march_contracts.csv'
    fx = FX(fx_path, as_of); matif = load_matif(matif_path, fx, as_of)
    if not matif:
        raise ValueError('No seasonal MATIF observations')
    current_year = max(s['year'] for s in matif)
    cbot, cbot_paths = load_us('cbot', source, fx, as_of)
    kc, kc_paths = load_us('kc', source, fx, as_of)
    series = {'matif': matif, 'cbot': cbot, 'kc': kc,
              'spreadCbot': spreads(matif, cbot), 'spreadKc': spreads(matif, kc)}
    cov = {name: coverage(values, name, current_year) for name, values in series.items()}
    paths = list(dict.fromkeys([matif_path, fx_path] + cbot_paths + kc_paths))
    provenance = {'matif': {'source': 'User-supplied Edge Euronext/MATIF settlement workbook',
                    'workbook': '58b45b1a5ec5_MATIF_milling_wheat_Mar_Sep_NovDec_2001_2027.xlsx',
                    'workbookSha256': '66ba60fb96eba4ba7d2b27e0a1e1ab77cc6e463cf2b635bd9c1c79682437ba0a',
                    'nativeUnits': 'EUR per metric tonne'},
                  'fx': {'source': 'ECB daily reference rate', 'units': 'USD per EUR',
                    'url': 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.zip',
                    'lastObservation': fx.days[-1].isoformat()},
                  'us': {'requiredSource': 'Actual same-delivery-year March Chicago SRW / KC HRW futures',
                         'nativeUnits': 'US cents per bushel', 'continuousContractsUsed': False},
                  'files': [{'file': p.name, 'sha256': digest(p)} for p in paths],
                  'conversionSource': 'https://www.cmegroup.com/trading/agricultural/files/AC-225_MetricGuide.pdf'}
    availability = {}
    for name in series:
        available = bool(series[name])
        label = {'matif': 'MATIF March', 'cbot': 'CBOT Chicago March', 'kc': 'Kansas City March',
                 'spreadCbot': 'MATIF minus CBOT March', 'spreadKc': 'MATIF minus Kansas City March'}[name]
        reason = 'Actual US March contract prices have not been loaded. No proxy prices are shown.'
        if name in ['spreadCbot', 'spreadKc'] and series['cbot' if name == 'spreadCbot' else 'kc']:
            reason = 'No same-date March observations overlap the MATIF data with eligible FX.'
        availability[name] = {'available': available, 'label': label,
             'status': 'available' if available else 'missing_source',
             'reason': None if available else reason}
    availability['fx'] = {'available': True, 'label': 'ECB USD per EUR', 'status': 'available', 'reason': None}
    bundle = {'schemaVersion': 1, 'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
              'asOf': max(p['date'] for s in matif for p in s['points']), 'requestedAsOf': as_of.isoformat(),
              'currentYear': current_year, 'years': [s['year'] for s in matif],
              'comparableYears': [r['year'] for r in cov['matif'] if r['isComparable']],
              'modernComparableYears': [r['year'] for r in cov['matif'] if r['isComparable'] and r['year'] >= 2010],
              'season': {'start': 'April 1 of previous calendar year', 'end': 'Last calendar day of February in delivery year',
                 'seasonDayDefinition': 'Actual calendar days elapsed since April 1 of the preceding year; leap-day observations are retained.',
                 'historicalBandRule': 'Aggregate within each delivery year first; equal-weight comparable completed years. Exclude current/partial seasons.',
                 'coverageRule': 'Comparable means completed year, at least 150 observations across all 11 season months, an observation by April 15 and on/after February 15; inspect gaps separately.',
                 'februaryCaveat': 'February observations are not necessarily before first-notice or holding dates.'},
              'conversion': {'bushelPounds': 60, 'kilogramsPerPound': .45359237,
                 'bushelsPerMetricTonne': float(BU_PER_TONNE), 'fxConvention': 'USD per EUR',
                 'fxMaximumBackwardAgeDays': FX_MAX_AGE_DAYS,
                 'eurSpread': 'MATIF EUR/t - (US cents/bu /100 * bushels/t) / EURUSD',
                 'usdSpread': 'MATIF EUR/t * EURUSD - US cents/bu /100 * bushels/t',
                 'positiveSpread': 'MATIF premium over the US March contract'},
              'availability': availability, 'series': series, 'coverage': cov,
              'latest': {name: latest(values, current_year) for name, values in series.items()},
              'provenance': provenance,
              'notes': ['Descriptive daily settlement comparison; venue settlements and ECB reference times are not synchronized.',
                        'No futures prices are carried across dates. Only FX may use a prior observation, limited to three calendar days.',
                        'March 2002 is a partial first season. Early MATIF contracts have many zero-volume days; zero reported OI may mean unavailable history.',
                        f'Current March {current_year} is incomplete and must be excluded from historical seasonal bands.',
                        'This dataset is not a trading backtest or evidence of executable spread profits.'],
              'downloads': {'matif': 'downloads/matif_march_daily.csv', 'coverage': 'downloads/coverage.csv',
                            'usTemplate': 'downloads/us_wheat_template.csv', 'fx': 'downloads/eurusd_ecb.csv',
                            'provenance': 'downloads/provenance.json'}}
    with (output / 'data.json').open('w', encoding='utf-8') as stream:
        json.dump(bundle, stream, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
    columns = ['date', 'delivery_year', 'contract', 'seasonDay', 'eurt', 'usdt', 'fx', 'fxdate', 'fxAgeDays', 'volume', 'openInterest']
    write_csv(downloads / 'matif_march_daily.csv', columns,
              [dict(p, delivery_year=s['year'], contract=s['contract']) for s in matif for p in s['points']])
    all_coverage = [row for values in cov.values() for row in values]
    write_csv(downloads / 'coverage.csv', list(all_coverage[0]), all_coverage)
    write_csv(downloads / 'us_wheat_template.csv', CSV_IMPORT_HEADER, [])
    for name in ['cbot', 'kc']:
        write_csv(downloads / f'{name}_march_template.csv', CSV_IMPORT_HEADER, [])
    shutil.copyfile(fx_path, downloads / 'eurusd_ecb.csv')
    (downloads / 'provenance.json').write_text(json.dumps(provenance, indent=2), encoding='utf-8')
    (source / 'source_provenance.json').write_text(json.dumps(provenance, indent=2), encoding='utf-8')
    return bundle


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-dir', type=Path, help='Optional actual-data directory to copy into project data/source')
    parser.add_argument('--output', type=Path, default=PROJECT / 'dist')
    parser.add_argument('--as-of', type=date.fromisoformat, default=datetime.now(timezone.utc).date())
    args = parser.parse_args(); source = PROJECT / 'data/source'; source.mkdir(parents=True, exist_ok=True)
    if args.source_dir:
        for name in SOURCE_NAMES:
            incoming = args.source_dir / name
            if incoming.exists() and incoming.resolve() != (source / name).resolve():
                shutil.copyfile(incoming, source / name)
    data = build(source, args.output, args.as_of)
    print(json.dumps({'asOf': data['asOf'], 'currentYear': data['currentYear'],
                      'points': {name: sum(len(s['points']) for s in values) for name, values in data['series'].items()},
                      'latestMatif': data['latest']['matif']}, indent=2))


if __name__ == '__main__':
    main()
