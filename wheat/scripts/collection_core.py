"""Public-data collection core extracted from the audited collector; no Site authentication."""
import csv, hashlib, io, json, tempfile, urllib.request, zipfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
import build_data
ECB = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist.zip'
MATIF_COLUMNS = ['date','contract','month','delivery_year','matif_eur_t','volume','open_interest']

def read_rows(text):
    return list(csv.DictReader(io.StringIO(text.lstrip('\ufeff'))))

def csv_text(rows, columns):
    out = io.StringIO(newline='')
    writer = csv.DictWriter(out, fieldnames=columns, extrasaction='ignore', lineterminator='\n')
    writer.writeheader(); writer.writerows(rows)
    return out.getvalue()

def fetch_fx():
    with urllib.request.urlopen(ECB, timeout=45) as response:
        archive = response.read(8_000_001)
    if len(archive) > 8_000_000: raise ValueError('ECB response exceeded expected size.')
    with zipfile.ZipFile(io.BytesIO(archive)) as z:
        names = [n for n in z.namelist() if n.endswith('.csv')]
        if len(names) != 1: raise ValueError('Unexpected ECB archive contents.')
        rows = read_rows(z.read(names[0]).decode('utf-8-sig'))
    clean = []
    for row in rows:
        normalized = {k.strip(): (v.strip() if v else '') for k,v in row.items() if k}
        day = normalized.get('Date',''); usd = normalized.get('USD','')
        if not day or not usd: continue
        day = date.fromisoformat(day)
        if day > datetime.now(timezone.utc).date(): raise ValueError('Future-dated ECB observation.')
        if float(usd) <= 0: raise ValueError('Invalid ECB USD/EUR rate.')
        clean.append({'date':day.isoformat(), 'eurusd_usd_per_eur':usd})
    if not clean: raise ValueError('No official ECB observations found.')
    return clean, hashlib.sha256(archive).hexdigest()

def merge_matif(old, incoming):
    values = {(r['date'], r['contract']):dict(r) for r in old}
    if len(values) != len(old): raise ValueError('Duplicate MATIF source keys.')
    added = amended = 0
    for row in incoming:
        key = row['date'], row['contract']
        previous = values.get(key)
        clean = {k: row.get(k, '') for k in MATIF_COLUMNS}
        for k in ['volume','open_interest']:
            if clean[k] is None or clean[k] == '': clean[k] = previous.get(k, '') if previous else ''
        if previous is None: added += 1
        elif float(previous['matif_eur_t']) != float(clean['matif_eur_t']): amended += 1
        values[key] = clean
    return sorted(values.values(), key=lambda r:(r['date'],r['contract'])), added, amended

def assemble(state, collected, fx_rows, fx_sha):
    sources = dict(state['sources'])
    all_old = read_rows(sources.get('matifAll') or csv_text([], MATIF_COLUMNS))
    all_rows, all_added, all_amended = merge_matif(all_old, collected['rows'])
    march_incoming = [r for r in collected['rows'] if r['month'] == 'Mar']
    if not march_incoming: raise ValueError('Official settlement response contains no March contracts.')
    march_rows, added, amended = merge_matif(read_rows(sources['matif']), march_incoming)
    sources['matif'] = csv_text(march_rows, MATIF_COLUMNS)
    sources['matifAll'] = csv_text(all_rows, MATIF_COLUMNS)
    existing_fx = {r['date']:r for r in read_rows(sources['fx'])}
    first_fx_date = min(existing_fx)
    for row in fx_rows:
        if row['date'] >= first_fx_date: existing_fx[row['date']] = row
    sources['fx'] = csv_text([existing_fx[d] for d in sorted(existing_fx)], ['date','eurusd_usd_per_eur'])
    with tempfile.TemporaryDirectory(prefix='wheat-refresh-') as folder:
        source = Path(folder)/'source'; output = Path(folder)/'output'
        source.mkdir(); output.mkdir()
        names = {'matif':'matif_march_contracts.csv','fx':'eurusd_ecb.csv','cbot':'cbot_march_daily.csv','kc':'kc_march_daily.csv'}
        for key, name in names.items():
            if sources.get(key): (source/name).write_text(sources[key], encoding='utf-8')
        dataset = build_data.build(source, output, datetime.now(timezone.utc).date())
    if dataset['asOf'] < state['dataset']['asOf']: raise ValueError('Refresh would move the dataset backwards.')
    prior_us_provenance = state['dataset'].get('provenance', {}).get('us')
    if prior_us_provenance and any(sources.get(key) for key in ['cbot','kc']):
        dataset['provenance']['us'] = prior_us_provenance
    stats = {'marchRowsAdded':added,'marchSettlementsAmended':amended,'allMaturitiesRowsAdded':all_added,
             'allMaturitiesSettlementsAmended':all_amended,'matifThrough':dataset['asOf'],
             'latestPublishedTradeDate':max(r['date'] for r in collected['rows']),
             'fxThrough':max(r['date'] for r in fx_rows)}
    gap_dates = list(state['dataset'].get('collection',{}).get('unverifiedGapDates',[]))
    oldest_recent = date.fromisoformat(min(r['date'] for r in collected['rows']))
    previous_latest = date.fromisoformat(state['dataset']['asOf'])
    day = previous_latest + timedelta(days=1)
    while day < oldest_recent:
        if day.weekday() < 5: gap_dates.append(day.isoformat())
        day += timedelta(days=1)
    current_year = dataset['currentYear']
    known = {r['date'] for r in march_rows if int(r['delivery_year']) == current_year}
    gap_dates = sorted(set(gap_dates)-known)
    stats['unverifiedGapDates'] = gap_dates
    dataset['collection'] = {'source':'Euronext official settlement prices', 'sourceUrl':collected['source_url'],
                             'latestPublishedTradeDate':stats['latestPublishedTradeDate'],
                             'availableTradeDates':collected['available_trade_dates'],
                             'unverifiedGapDates':gap_dates,
                             'coverageNote':'Recent published dates are collected; older missing business dates require a historical source.'}
    dataset['provenance']['matif']['updatesSource'] = collected['source_url']
    dataset['provenance']['matif']['updatesNote'] = 'Initial history comes from the supplied workbook; subsequent published settlements and revisions come from Euronext.'
    dataset['provenance']['matif']['openInterestNote'] = 'Euronext open-interest timing may differ from the workbook; source revisions are retained.'
    collection = {'sourceUrl':collected['source_url'],'availableTradeDates':collected['available_trade_dates'],
                  'rawResponses':collected['raw_responses'],'ecbArchiveSha256':fx_sha,
                  'selectableTradeDates':collected.get('selectable_trade_dates', collected['available_trade_dates']),
                  'unpublishedDates':collected.get('unpublished_dates',[]),
                  'observedAt':datetime.now(timezone.utc).isoformat(timespec='seconds'), 'stats':stats}
    return {'schemaVersion':1,'dataset':dataset,'sources':sources,'collection':collection}, stats
