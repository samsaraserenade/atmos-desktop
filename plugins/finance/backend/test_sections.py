import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import server
import collectors

class SectionTests(unittest.TestCase):
    def test_snapshots_and_migration(self):
        with tempfile.TemporaryDirectory() as directory:
            db = str(Path(directory) / 'test.db')
            server.migrate(db)
            with server.connect(db) as conn:
                conn.execute("INSERT INTO portfolio_samples (ts_ms,total,invested,cash,currency,error_count) VALUES (1,100,0,100,'USD',0)")
            server.migrate(db)
            self.assertIsNone(server.history(db, 0, 10, 'raw')[0]['perp'])
            for ts, holdings in [(1000,[{'symbol':'USDC','kind':'cash','value':70,'meta':{'instrument':'perp-cash'}},{'symbol':'BTC Perp','value':30,'meta':{'instrument':'perp'}}]),(2000,[{'symbol':'USDC','kind':'cash','value':100}])]:
                server.ingest(db, {'ts_ms':ts,'sources':[{'id':'hyperliquid-wallet','value':100,'holdings':holdings},{'id':'spot','value':50,'holdings':[{'symbol':'USDC','kind':'cash','value':50}]}]})
                current=server.latest(db)
                self.assertEqual((current['spot'],current['perp'],current['total']),(50,100,150))
            for resolution in server.RESOLUTIONS_MS:
                point=server.history(db,1000,3000,resolution)[-1]
                self.assertEqual((point['spot'],point['perp'],point['v']),(50,100,150))
            self.assertEqual(server.holdings_history(db,2000,2000,'hyperliquid-wallet')[0]['meta']['instrument'],'perp-cash')
            self.assertEqual(server.integrity_check(db),'ok')

    def test_idle_collector(self):
        def info(payload):
            if payload['type']=='spotClearinghouseState': return {'balances':[{'coin':'USDC','total':'100'}]}
            if payload['type']=='borrowLendUserState': return {'tokenToState':[]}
            if payload['type']=='clearinghouseState': return {'assetPositions':[]}
            return {}
        with patch.object(collectors,'_hl_spot_meta',return_value={}), patch.object(collectors,'_hl_info',side_effect=info), patch.object(collectors,'_hl_funding_rates',return_value={}), patch.object(collectors,'_hl_spot_price',return_value=1):
            result=collectors.collect_hyperliquid({'addresses':['test']})
        self.assertEqual(result['value'],100)
        self.assertEqual(result['holdings'][0]['meta']['instrument'],'perp-cash')

    def test_earn_supply_is_counted_in_perp_with_interest_as_return(self):
        def info(payload):
            if payload['type']=='spotClearinghouseState': return {'balances':[]}
            if payload['type']=='borrowLendUserState':
                return {'tokenToState': [[0, {
                    'borrow': {'basis': '0.0', 'value': '0.0'},
                    'supply': {'basis': '170.0', 'value': '170.00023442'},
                }]]}
            if payload['type']=='clearinghouseState': return {'assetPositions':[]}
            return {}
        spot_meta = {'tokens': [{'index': 0, 'name': 'USDC'}], 'universe': []}
        with patch.object(collectors,'_hl_spot_meta',return_value=spot_meta), patch.object(collectors,'_hl_info',side_effect=info), patch.object(collectors,'_hl_funding_rates',return_value={}):
            result=collectors.collect_hyperliquid({'addresses':['test']})
        self.assertAlmostEqual(result['value'],170.00023442)
        self.assertEqual(result['error_count'],0)
        earn=result['holdings'][0]
        self.assertEqual(earn['symbol'],'USDC Earn')
        self.assertEqual(earn['quantity'],170.0)
        self.assertAlmostEqual(earn['price'],170.00023442/170.0)
        self.assertEqual(earn['kind'],'cash')
        self.assertEqual(earn['meta']['instrument'], 'perp-cash')
        self.assertEqual(earn['meta']['account'], 'earn')
        self.assertEqual(earn['meta']['protocolType'], 'Lending')
        self.assertEqual(earn['meta']['dapp'], 'Hyperliquid')
        self.assertEqual(earn['meta']['walletAddress'], 'test')
        cleaned=server.clean_frame({'sources':[result]})
        self.assertAlmostEqual(cleaned['perp'],170.00023442)
        self.assertEqual(cleaned['spot'],0)

    def test_earn_failure_keeps_spot_and_perp_data(self):
        def info(payload):
            if payload['type']=='spotClearinghouseState': return {'balances':[{'coin':'USDC','total':'25'}]}
            if payload['type']=='borrowLendUserState': raise collectors.CollectorError('temporary')
            if payload['type']=='clearinghouseState': return {'assetPositions':[]}
            return {}
        with patch.object(collectors,'_hl_spot_meta',return_value={}), patch.object(collectors,'_hl_info',side_effect=info), patch.object(collectors,'_hl_funding_rates',return_value={}), patch.object(collectors,'_hl_spot_price',return_value=1):
            result=collectors.collect_hyperliquid({'addresses':['test']})
        self.assertEqual(result['value'],25)
        self.assertEqual(result['error_count'],1)

    def test_open_cross_margin_position_survives_zero_local_equity(self):
        def info(payload):
            if payload['type']=='spotClearinghouseState':
                return {'balances':[{'coin':'USDC','total':'141.25'}]}
            if payload['type']=='borrowLendUserState': return {'tokenToState':[]}
            if payload['type']=='clearinghouseState':
                return {'assetPositions':[{'position':{
                    'coin':'BTC','szi':'0.01','entryPx':'25000',
                    'positionValue':'500','marginUsed':'50',
                    'unrealizedPnl':'-104.16','liquidationPx':'10000',
                    'leverage':{'value':10},
                }}]}
            return {}
        with patch.object(collectors,'_hl_spot_meta',return_value={}), \
             patch.object(collectors,'_hl_info',side_effect=info), \
             patch.object(collectors,'_hl_funding_rates',return_value={}), \
             patch.object(collectors,'_hl_funding_24h',return_value={}), \
             patch.object(collectors,'_hl_fees_24h',return_value={}), \
             patch.object(collectors,'_hl_spot_price',return_value=1):
            result=collectors.collect_hyperliquid({'addresses':['test']})
        position=next(h for h in result['holdings'] if h['meta']['instrument']=='perp')
        self.assertEqual(position['value'],0)
        self.assertGreater(position['quantity'],0)
        self.assertEqual(position['meta']['positionValue'],500)

        with tempfile.TemporaryDirectory() as directory:
            db=str(Path(directory)/'test.db')
            server.migrate(db)
            server.ingest(db, {'ts_ms':1000,'sources':[result]})
            stored=[h for h in server.latest(db)['holdings'] if h['meta']['instrument']=='perp']
            self.assertEqual(len(stored),1)
            self.assertEqual(stored[0]['value'],0)

if __name__=='__main__': unittest.main()
