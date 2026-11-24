#!/usr/bin/env python3
"""Refresh only public wheat sources and static outputs; no account credentials.

Failures leave the published data unchanged. GitHub commits the complete output
set only after success; the collector never commits, pushes or changes Pages.
"""
import argparse
import copy
import csv
import hashlib
import io
import json
import os
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
import tempfile
from zoneinfo import ZoneInfo

import build_data
import collection_core as core
import matif_euronext

WHEAT = Path(__file__).resolve().parents[1]
NAMES = {'matif':'matif_march_contracts.csv','fx':'eurusd_ecb.csv','matifAll':'matif_all_contracts.csv',
         'cbot':'cbot_march_daily.csv','kc':'kc_march_daily.csv'}


def schedule_due(event, cron, now=None):
    """Select the cron matching22:30Zurich; delayed jobs retain their cron identity."""
    if event == 'workflow_dispatch': return True
    if event != 'schedule': return False
    local=(now or datetime.now(timezone.utc)).astimezone(ZoneInfo('Europe/Zurich'))
    offset=int(local.utcoffset().total_seconds()/3600)
    return cron == f'30 {22-offset} * * *'


def load_state(root):
    dataset=json.loads((root/'data.json').read_text(encoding='utf-8'))
    sources={k:(root/'data/source'/n).read_text(encoding='utf-8') for k,n in NAMES.items() if (root/'data/source'/n).exists()}
    assert sources.get('matif') and sources.get('fx'), 'MATIF/ECB source history is required'
    state={'schemaVersion':1,'dataset':dataset,'sources':sources}
    evidence=root/'data/last_collection.json'
    if evidence.exists():state['collection']=json.loads(evidence.read_text(encoding='utf-8'))
    return state


def source_rows(text, name):
    rows=core.read_rows(text)
    key=lambda r:(r['date'],r.get('contract',''))
    assert len({key(r) for r in rows})==len(rows), (name,'duplicate source keys')
    return {key(r):r for r in rows}


def semantic_hash(state):
    normalized={}
    for name,text in state['sources'].items():
        values=[]
        for key,row in sorted(source_rows(text,name).items()):
            clean={}
            for field,value in row.items():
                value=(value or '').strip()
                if field not in {'date','contract','month','market'} and value:
                    try:value=str(Decimal(value).normalize())
                    except InvalidOperation:pass
                clean[field]=value
            values.append(clean)
        normalized[name]=values
    def stable(value):
        # JavaScript serializes 233.0 as233; a Python rebuild must not classify
        # that equivalent JSON number as a changed settlement.
        if isinstance(value,float) and value.is_integer():return int(value)
        if isinstance(value,list):return [stable(v) for v in value]
        if isinstance(value,dict):return {k:stable(v) for k,v in value.items()}
        return value
    body={'sources':normalized,'series':stable(state['dataset']['series'])}
    return hashlib.sha256(json.dumps(body,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()


def verify(previous, proposed):
    assert proposed['dataset']['asOf']>=previous['dataset']['asOf'], 'Date moved backwards'
    for name,text in previous['sources'].items():
        before=source_rows(text,name);after=source_rows(proposed['sources'][name],name)
        assert before.keys()<=after.keys(), (name,'history removal refused')
        if name in {'cbot','kc'}:assert proposed['sources'][name]==text,(name,'US history changed during MATIF collection')
    if any(name in previous['sources'] for name in ('cbot','kc')):
        assert proposed['dataset']['provenance']['us']==previous['dataset']['provenance']['us'], 'US provenance changed'
    for market in ('matif','cbot','kc'):
        for season in proposed['dataset']['series'][market]:
            year=season['year'];root={'matif':'MLH','cbot':'ZW-','kc':'KE-'}[market]
            expected=f'MLH{year%100:02}' if market=='matif' else f'{root}{year}H'
            assert season['contract']==expected,(market,'wrong delivery contract')
            for p in season['points']:
                assert p['date']<=datetime.now(timezone.utc).date().isoformat()
                assert p['eurt'] is None or p['eurt']>0
                assert p['usdt'] is None or p['usdt']>0
                assert p['fxAgeDays'] is None or 0<=p['fxAgeDays']<=3
    # A literal repeat must retain all US series/spreads; changed FX may legitimately
    # alter conversions when a reference rate arrives or is revised.
    if previous['sources']['fx']==proposed['sources']['fx'] and previous['sources']['matif']==proposed['sources']['matif']:
        for market in ('cbot','kc','spreadCbot','spreadKc'):
            assert proposed['dataset']['series'][market]==previous['dataset']['series'][market],market


def prepare(state, collected, fx_rows, fx_hash, now=None):
    frozen=copy.deepcopy(state)
    proposed,stats=core.assemble(state,collected,fx_rows,fx_hash)
    assert state==frozen,'Collector mutated its input'
    verify(state,proposed)
    stamp=(now or datetime.now(timezone.utc)).isoformat(timespec='seconds')
    changed=semantic_hash(state)!=semantic_hash(proposed)
    prior=state['dataset'].get('refresh',{})
    proposed['dataset']['refresh']={'status':'updated' if changed else 'no_new_data','lastAttemptAt':stamp,
        'lastSuccessAt':stamp,'lastDataChangeAt':stamp if changed else prior.get('lastDataChangeAt'),
        'lastError':None,'method':'Public GitHub Actions collector; no private Site access'}
    return proposed,stats


def csv_text(columns,rows):
    return core.csv_text(rows,columns)


def render_files(proposed):
    data=proposed['dataset'];files={'data.json':json.dumps(data,separators=(',',':'),ensure_ascii=False,allow_nan=False)+'\n'}
    for key,text in proposed['sources'].items():files['data/source/'+NAMES[key]]=text
    files['data/source/source_provenance.json']=json.dumps(data['provenance'],indent=2)+'\n'
    if 'collection' in proposed:
        files['data/last_collection.json']=json.dumps(proposed['collection'],indent=2,ensure_ascii=False,allow_nan=False)+'\n'
    fields=['date','delivery_year','contract','seasonDay','eurt','usdt','fx','fxdate','fxAgeDays','volume','openInterest']
    for market in ('matif','cbot','kc'):
        points=[dict(p,delivery_year=s['year'],contract=s['contract']) for s in data['series'][market] for p in s['points']]
        files[f'downloads/{market}_march_daily.csv']=csv_text(fields+(['settleCentsBu'] if market!='matif' else []),points)
    coverage=[row for group in data['coverage'].values() for row in group]
    files['downloads/coverage.csv']=csv_text(list(coverage[0]),coverage)
    files['downloads/eurusd_ecb.csv']=proposed['sources']['fx']
    files['downloads/matif_all_contracts.csv']=proposed['sources'].get('matifAll',csv_text(core.MATIF_COLUMNS,[]))
    files['downloads/provenance.json']=json.dumps(data['provenance'],indent=2)+'\n'
    for name in ('us_wheat_template.csv','cbot_march_template.csv','kc_march_template.csv'):
        files['downloads/'+name]=csv_text(['date','delivery_year','settle_cents_bu'],[])
    return files


def write_files(root,files):
    # Build every byte before replacing files. The workflow commits only after
    # this process succeeds, so no partial generated tree reaches Pages.
    with tempfile.TemporaryDirectory(prefix='wheat-public-write-') as folder:
        stage=Path(folder)
        for relative,text in files.items():
            path=stage/relative;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(text,encoding='utf-8')
        for relative in files:
            target=root/relative;target.parent.mkdir(parents=True,exist_ok=True)
            # Write beside the destination for an atomic per-file replace.
            temp=target.with_name(target.name+'.pending');temp.write_bytes((stage/relative).read_bytes());temp.replace(target)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,default=WHEAT)
    parser.add_argument('--schedule-guard',action='store_true')
    parser.add_argument('--rebuild-only',action='store_true',help='Render downloads from the existing dataset without fetching or changing prices/provenance')
    args=parser.parse_args()
    if args.schedule_guard:
        due=schedule_due(os.getenv('GITHUB_EVENT_NAME',''),os.getenv('SCHEDULE_CRON',''))
        print('run='+str(due).lower());return
    state=load_state(args.root)
    if args.rebuild_only:
        verify(state,state);files=render_files(state);write_files(args.root,files)
        print(json.dumps({'status':'rebuilt_existing_data','asOf':state['dataset']['asOf'],'filesWritten':len(files)}));return
    # Official public endpoints only. A source error aborts before any output write.
    collected=matif_euronext.collect();fx_rows,fx_hash=core.fetch_fx()
    proposed,stats=prepare(state,collected,fx_rows,fx_hash)
    files=render_files(proposed);write_files(args.root,files)
    print(json.dumps({'status':proposed['dataset']['refresh']['status'],**stats,'filesWritten':len(files)},indent=2))


if __name__=='__main__':main()
