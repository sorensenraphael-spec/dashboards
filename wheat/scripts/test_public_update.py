#!/usr/bin/env python3
"""Bounded offline regression against the repository's actual sources."""
import copy
from datetime import datetime, timezone
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import collection_core as core
import update_public as update
import matif_euronext as matif
from datetime import timedelta


class PublicUpdateTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.state=update.load_state(update.WHEAT)

    def replay(self):
        state=copy.deepcopy(self.state)
        collection=state.get('collection',{})
        rows=core.read_rows(state['sources']['matifAll'])
        known=state['dataset']['collection']
        evidence={'rows':rows,'source_url':known['sourceUrl'],
            'available_trade_dates':known['availableTradeDates'],
            'raw_responses':collection.get('rawResponses',[])}
        with patch('urllib.request.urlopen',side_effect=AssertionError('Network forbidden in tests')):
            return update.prepare(state,evidence,core.read_rows(state['sources']['fx']),collection.get('ecbArchiveSha256'))

    def test_actual_repeat_preserves_history_us_and_provenance(self):
        proposed,stats=self.replay()
        self.assertEqual(proposed['dataset']['refresh']['status'],'no_new_data')
        self.assertEqual(update.semantic_hash(self.state),update.semantic_hash(proposed))
        for name in ('cbot','kc'):
            self.assertEqual(proposed['sources'][name],self.state['sources'][name])
        self.assertEqual(proposed['dataset']['provenance']['us'],self.state['dataset']['provenance']['us'])
        for name in ('matif','cbot','kc','spreadCbot','spreadKc'):
            self.assertEqual(proposed['dataset']['series'][name],self.state['dataset']['series'][name])
        for k in ('marchRowsAdded','marchSettlementsAmended','allMaturitiesRowsAdded','allMaturitiesSettlementsAmended'):
            self.assertEqual(stats[k],0)

    def test_history_deletion_refused(self):
        bad=copy.deepcopy(self.state);lines=bad['sources']['matif'].splitlines();bad['sources']['matif']='\n'.join([lines[0]]+lines[2:])+'\n'
        with self.assertRaisesRegex(AssertionError,'history removal'):
            update.verify(self.state,bad)

    def test_failed_fetch_leaves_all_files_unchanged(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);update.write_files(root,update.render_files(self.state))
            before={str(p.relative_to(root)):p.read_bytes() for p in root.rglob('*') if p.is_file()}
            with patch('sys.argv',['update_public.py','--root',folder]),patch('update_public.matif_euronext.collect',side_effect=ValueError('source unavailable')):
                with self.assertRaisesRegex(ValueError,'source unavailable'):update.main()
            after={str(p.relative_to(root)):p.read_bytes() for p in root.rglob('*') if p.is_file()}
            self.assertEqual(after,before)

    def test_static_downloads_match_source_data(self):
        files=update.render_files(self.state)
        self.assertEqual(json.loads(files['data.json']),self.state['dataset'])
        self.assertEqual(files['downloads/matif_all_contracts.csv'],self.state['sources']['matifAll'])
        self.assertEqual(len(core.read_rows(files['downloads/matif_march_daily.csv'])),sum(len(s['points']) for s in self.state['dataset']['series']['matif']))
        self.assertEqual(core.read_rows(files['downloads/us_wheat_template.csv']),[])
        with tempfile.TemporaryDirectory() as folder:
            update.write_files(Path(folder),files)
            self.assertEqual(json.loads((Path(folder)/'data.json').read_text(encoding='utf-8')),self.state['dataset'])
            self.assertFalse(list(Path(folder).rglob('*.pending')))

    def test_latest_unpublished_date_does_not_discard_previous_settlement(self):
        today=datetime.now(timezone.utc).date()
        earlier=(today-timedelta(days=1)).isoformat()
        current=today.isoformat()
        maturities=[{'value':'03-01-2027','month':'Mar','delivery_year':2027}]
        selection={'maturities':maturities,'trade_dates':[{'date':earlier,'value':'old'},{'date':current,'value':'new'}]}
        row={'date':earlier,'contract':'MLH27','month':'Mar','delivery_year':2027}
        with patch.object(matif,'_request',return_value={'body':'test'}),patch.object(matif,'parse_selection_page',return_value=selection),patch.object(matif,'parse_settlement_table',side_effect=[([row],{'date':earlier,'status':'published'}),matif.DateMismatch(current,earlier)]):
            result=matif.collect()
        self.assertEqual(result['rows'],[row])
        self.assertEqual(result['unpublished_dates'],[current])
        with patch.object(matif,'_request',return_value={'body':'test'}),patch.object(matif,'parse_selection_page',return_value=selection),patch.object(matif,'parse_settlement_table',side_effect=matif.DateMismatch(earlier,current)):
            with self.assertRaises(matif.DateMismatch):
                matif.collect()

    def test_swiss_schedule_winter_summer_and_dispatch(self):
        winter=datetime(2026,11,20,21,50,tzinfo=timezone.utc)
        summer=datetime(2026,7,20,20,55,tzinfo=timezone.utc)
        self.assertTrue(update.schedule_due('schedule','30 21 * * *',winter))
        self.assertFalse(update.schedule_due('schedule','30 20 * * *',winter))
        self.assertTrue(update.schedule_due('schedule','30 20 * * *',summer))
        self.assertFalse(update.schedule_due('schedule','30 21 * * *',summer))
        self.assertTrue(update.schedule_due('workflow_dispatch','',winter))
        self.assertFalse(update.schedule_due('push','',winter))


if __name__=='__main__':unittest.main()
