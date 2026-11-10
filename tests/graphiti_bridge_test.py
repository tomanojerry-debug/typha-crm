"""Pure contract checks; no model, network or private data."""
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('graphiti_bridge',Path(__file__).parents[1]/'scripts/graphiti/bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

class GraphitiContractTests(unittest.TestCase):
    def test_project_and_trust_partitions(self):
        first={'project_id':None,'trust':'customer_quote'}
        self.assertNotEqual(bridge.source_group(first),bridge.source_group({**first,'project_id':'p'}))
        self.assertNotEqual(bridge.source_group(first),bridge.source_group({**first,'trust':'company_confirmed'}))


class StructuredProjectionTests(unittest.TestCase):
    def record(self, record_id, body, prior=None):
        claim={'id':'quantity','entity_ref':'company','field_id':None,'field_label':'数量',
               'value':{'type':'number','value':80,'unit':'件'},'speaker_id':'s1',
               'modality':'requested','effective_at':None,'evidence':[{'message_id':record_id,'quote':body}]}
        return {'input':{'messages':[{'id':record_id,'speaker_id':'s1','text':body,'occurred_at':'2026-10-22T01:00:00Z'}],
                         'speakers':[{'id':'s1','name':'顾老师'}]},
                'output':{'record_id':record_id,'entities':[{'ref':'company','kind':'company','name':'演示公司','canonical_id':'crm-company'}],
                          'attributes':[claim],'relations':[], 'changes':[] if not prior else [{'new_claim_id':'quantity','old_claim_id':prior,'kind':'proposed_change','evidence':claim['evidence']}]},
                'source_ids':[record_id],'project_id':None,'trust':'customer_quote'}

    def test_canonical_identity_typed_value_and_episode_are_stable(self):
        record=self.record('record-one','需要80件')
        plan=bridge.project_records([record])[0]
        self.assertEqual(plan['nodes'][0]['uuid'],'crm-company')
        self.assertEqual(plan['edges'][0]['uuid'],bridge.stable_id('record-one','quantity'))
        self.assertIsNone(plan['edges'][0]['valid_at'])
        self.assertIn('80件',plan['edges'][0]['fact'])
        self.assertEqual(plan,bridge.project_records([record])[0])

    def test_original_episode_without_entities_or_facts_is_valid_and_skips_only_expected_empty_readbacks(self):
        record = self.record('unextracted-original', '我们主打儿童芭蕾裙。')
        record['output'].update({'entities': [], 'attributes': []})
        plans = bridge.project_records([record])
        self.assertEqual(len(plans), 1)
        self.assertEqual(plans[0]['nodes'], [])
        self.assertEqual(plans[0]['edges'], [])
        self.assertIn('我们主打儿童芭蕾裙。', plans[0]['content'])
        sizes = bridge.expected_group_sizes({'entities': [{'id': 'company'}], 'relationships': []}, plans)
        self.assertEqual(sizes['crm'], [1, 0])
        self.assertEqual(sizes[plans[0]['group']], [0, 0])
        # The readback must still query (and fail if absent) a planned nonempty
        # set rather than swallowing GroupsEdgesNotFoundError unconditionally.
        nonempty = bridge.project_records([self.record('fact', '需要80件')])
        self.assertEqual(bridge.expected_group_sizes({'entities': [], 'relationships': []}, nonempty)[nonempty[0]['group']], [2, 1])

    def test_episode_normalizes_search_whitespace_without_mutating_originals_or_backslashes(self):
        body = '洗护附录\nAQUACARE 30度手洗\t不可漂白；保留路径 C:\\care\\note\n最后一行。'
        record = self.record('original-message', body)
        # This valid structured claim remains in the graph but must not be
        # mixed into the original Episode text as a second apparent source.
        record['output']['attributes'][0]['field_label'] = '不应混入Episode的抽取字段'
        record['input']['speakers'].append({'id': 's2', 'name': '本方同事'})
        second = '收到\t请先核实。\n不可把客户请求当公司确认。'
        record['input']['messages'].append({'id': 'reply-message', 'speaker_id': 's2',
                                           'text': second, 'occurred_at': '2026-10-22T02:00:00Z'})
        plan = bridge.project_records([record])[0]
        expected = ('消息ID：original-message\n说话人：顾老师\n时间：2026-10-22T01:00:00Z\n原文：\n' + body +
                    '\n\n消息ID：reply-message\n说话人：本方同事\n时间：2026-10-22T02:00:00Z\n原文：\n' + second)
        self.assertEqual(plan['content'], ' '.join(expected.split()))
        self.assertIn(' AQUACARE ', plan['content'])
        self.assertNotIn('\\nAQUACARE', plan['content'])
        self.assertNotIn('\n', plan['content'])
        self.assertNotIn('\t', plan['content'])
        self.assertIn('C:\\care\\note', plan['content'])
        self.assertEqual(record['input']['messages'][0]['text'], body)
        self.assertEqual(record['input']['messages'][1]['text'], second)
        self.assertNotIn('不应混入Episode的抽取字段', plan['content'])
        self.assertIn('不应混入Episode的抽取字段', plan['edges'][0]['fact'])

    def test_change_preserves_old_claim_and_both_record_sources(self):
        first=self.record('old','需要100件')
        second=self.record('new','建议80件',bridge.stable_id('old','quantity'))
        plans=bridge.project_records([first,second])
        self.assertIsNone(plans[0]['edges'][0]['invalid_at'])
        self.assertEqual(plans[1]['edges'][-1]['target'],plans[0]['edges'][0]['uuid'])
        self.assertEqual(plans[1]['edges'][-1]['source_ids'],['new','old'])
        second['project_id']='different-project'
        with self.assertRaises(ValueError):bridge.project_records([first,second])

    def test_unknown_entities_with_same_name_are_not_silently_merged_across_records(self):
        first=self.record('one','需要80件');second=self.record('two','需要80件')
        first['output']['entities'][0]['canonical_id']=None
        second['output']['entities'][0]['canonical_id']=None
        plans=bridge.project_records([first,second])
        self.assertNotEqual(plans[0]['nodes'][0]['uuid'],plans[1]['nodes'][0]['uuid'])

    def test_change_cites_old_new_and_separate_correction_message(self):
        first=self.record('old','先按100件')
        second=self.record('new','改为80件',bridge.stable_id('old','quantity'))
        second['input']['messages'].append({'id':'confirmation','speaker_id':'s1','text':'以最新为准','occurred_at':'2026-10-22T02:00:00Z'})
        second['source_ids'].append('confirmation')
        second['output']['changes'][0]['evidence']=[{'message_id':'confirmation','quote':'以最新为准'}]
        plans=bridge.project_records([first,second])
        self.assertEqual(set(plans[-1]['edges'][-1]['source_ids']),{'old','new','confirmation'})

    def test_custom_object_and_currency_are_preserved_without_inventing_business_fields(self):
        record=self.record('custom-record','预算人民币80元')
        record['output']['entities'][0].update({'kind':'custom','object_id':'registered-object'})
        record['output']['attributes'][0]['value']={'type':'currency','value':80,'currency':'CNY','unit':None}
        plan=bridge.project_records([record])[0]
        self.assertEqual(plan['nodes'][0]['attributes']['object_id'],'registered-object')
        self.assertIn('80 CNY',plan['edges'][0]['fact'])

    def test_persisted_projection_keeps_partitions_and_rejects_broken_lineage(self):
        record=self.record('record-one','需要80件')
        group=bridge.source_group(record)
        plan=bridge.project_records([record])[0]
        sources={'record-one':{'record_id':'record-one','project_id':None,'trust':'customer_quote'}}
        persisted_nodes=[{'uuid':'crm-company','group':'crm','name':'正式公司','labels':['Entity','Company'],
                          'attributes':{'object_id':'customers','crm_json':'{"name":"正式公司"}'}}]
        persisted_nodes += [{'uuid':n['uuid'],'group':group,'name':n['name'],'labels':['Entity',n['label']],
                             'attributes':n['attributes']} for n in plan['nodes']]
        persisted_edges=[{'uuid':e['uuid'],'group':group,'source':e['source'],'target':e['target'],
                          'name':e['name'],'fact':e['fact'],'attributes':e['attributes'],
                          'valid_at':None,'invalid_at':None} for e in plan['edges']]
        graph=bridge.graph_projection(persisted_nodes,persisted_edges,sources)
        same_id=[n for n in graph['nodes'] if n['id']=='crm-company']
        self.assertEqual(len(same_id),2)
        self.assertNotEqual(same_id[0]['key'],same_id[1]['key'])
        self.assertEqual(graph['edges'][0]['kind'],'attribute_candidate')
        keys={n['key'] for n in graph['nodes']}
        self.assertIn(graph['edges'][0]['source'],keys)
        self.assertIn(graph['edges'][0]['target'],keys)
        persisted_edges[0]['attributes']['source_ids_json']=json.dumps(['foreign-source'])
        with self.assertRaises(ValueError):bridge.graph_projection(persisted_nodes,persisted_edges,sources)

if __name__=='__main__':
    unittest.main()
