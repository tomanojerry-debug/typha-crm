"""Private, one-job Graphiti runner. stdin/stdout JSON; no HTTP/MCP listener.

Each successful generation is immutable. Validated Record extractions are cached
by the CRM; this runner materializes those candidates without another LLM pass.
The CRM publishes a generation only after rechecking authorization and input.
"""
import asyncio
import contextlib
import hashlib
import json
import logging
import os
from pathlib import Path
import shutil
import sys
from datetime import datetime, timezone
from uuid import UUID

os.umask(0o077)
os.environ['GRAPHITI_TELEMETRY_ENABLED'] = 'false'
os.environ['ANONYMIZED_TELEMETRY'] = 'false'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
os.environ['EMBEDDING_DIM'] = '384'
logging.disable(logging.CRITICAL)

MODEL = 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2'


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def source_group(source):
    # Project and trust boundaries are physical FalkorDB graph boundaries.
    return 'evidence_' + fingerprint([source['project_id'], source['trust']])[:32]


def discard(job):
    import redis
    root = Path(os.environ['GRAPHITI_DATA_DIR']).resolve()
    directory = root / str(UUID(job['workspace'])) / str(UUID(job['customer'])) / str(UUID(job['generation']))
    settings = directory / 'graph.rdb.settings'
    if settings.is_file():
        config = json.loads(settings.read_text())
        if Path(config['dbdir']).resolve() != directory:
            raise ValueError('Invalid private graph directory')
        connection = redis.Redis(unix_socket_path=config['unixsocket'], decode_responses=True,
                                 socket_timeout=3, socket_connect_timeout=3)
        try:
            if Path(connection.config_get('dir')['dir']).resolve() != directory:
                raise ValueError('Private graph socket no longer belongs to this generation')
            connection.shutdown(nosave=True)
        except redis.ConnectionError:
            pass  # Already stopped.
        finally:
            connection.close()
    if directory.is_dir():
        shutil.rmtree(directory)


def stable_id(*parts):
    # Mirrors communication-pipeline.claimKey for claim references.
    raw = hashlib.sha256(json.dumps(list(parts), ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
    return f'{raw[:8]}-{raw[8:12]}-5{raw[13:16]}-a{raw[17:20]}-{raw[20:32]}'


def episode_content(messages, speakers):
    """Derived text for fulltext search; authoritative originals remain in CRM.

    Normalize whitespace into ordinary spaces so Graphiti/Falkor's fulltext
    index keeps the same token boundaries across newlines and tabs. Messages
    are never mutated; quoted evidence is always re-read from the CRM Record.
    Structured claims remain in the graph/CRM, outside this search document.
    """
    text = '\n\n'.join(
        '消息ID：' + message['id'] + '\n'
        '说话人：' + speakers[message['speaker_id']] + '\n'
        '时间：' + message['occurred_at'] + '\n'
        '原文：\n' + message['text']
        for message in messages
    )
    return ' '.join(text.split())


def project_records(records):
    """Pure, deterministic Graphiti plan from server-validated candidates; no re-extraction."""
    plans = []
    all_claims = {}
    for record in records:
        result, data = record['output'], record['input']
        rid = result['record_id']
        group = source_group(record)
        episode = stable_id(rid, 'episode')
        messages = {m['id']: m for m in data['messages']}
        speakers = {s['id']: s['name'] for s in data['speakers']}
        entities = {e['ref']: e for e in result['entities']}
        identities = {ref: e['canonical_id'] or stable_id(rid, 'entity', ref) for ref, e in entities.items()}
        nodes, edges = [], []
        for ref, e in entities.items():
            nodes.append({'uuid':identities[ref], 'name':e['name'], 'label':e['kind'].title(),
                          'attributes':{'canonical_id':e['canonical_id'] or '', 'candidate':True,
                            'object_id':e.get('object_id') or {'company':'customers','person':'people','project':'projects'}.get(e['kind'], ''),
                            'source_ids_json':json.dumps(record['source_ids'])}})
        modalities = {'stated':'陈述','requested':'请求','estimated':'预估','proposed':'建议',
                      'questioned':'询问','negated':'否认','reported':'转述'}
        def edge_plan(uuid, source, target, name, fact, claim, source_ids, effective=None):
            return {'uuid':uuid, 'source':source, 'target':target, 'name':name, 'fact':fact,
                    'valid_at':effective, 'invalid_at':None, 'source_ids':source_ids,
                    'attributes':{'record_id':rid, 'claim_json':json.dumps(claim, ensure_ascii=False),
                                  'source_ids_json':json.dumps(source_ids),
                                  'project_id':record['project_id'] or '', 'trust':record['trust']}}
        for claim in result['attributes'] + result['relations']:
            cid = stable_id(rid, claim['id'])
            source_ids = list(dict.fromkeys(e['message_id'] for e in claim['evidence']))
            observed = list(dict.fromkeys(messages[e['message_id']]['occurred_at'] for e in claim['evidence']))
            prefix = speakers[claim['speaker_id']] + '（' + modalities[claim['modality']] + '）：'
            if 'entity_ref' in claim:
                val = claim['value']
                text = json.dumps(val['value'], ensure_ascii=False) if not isinstance(val['value'], str) else val['value']
                text += val['unit'] or ''
                if val.get('currency'):
                    text += ' ' + val['currency']
                name = claim['field_label']
                fact = prefix + entities[claim['entity_ref']]['name'] + ' — ' + name + '：' + text
                source, target = identities[claim['entity_ref']], cid
            else:
                name = claim['label']
                fact = prefix + entities[claim['from_ref']]['name'] + ' — ' + name + ' → ' + entities[claim['to_ref']]['name']
                source, target = identities[claim['from_ref']], identities[claim['to_ref']]
            metadata = {**claim, 'observed_at':observed, 'speaker':speakers[claim['speaker_id']]}
            nodes.append({'uuid':cid, 'name':name, 'label':'Claim',
                          'attributes':{'record_id':rid, 'claim_json':json.dumps(metadata, ensure_ascii=False),
                            'source_ids_json':json.dumps(source_ids)}})
            edges.append(edge_plan(cid, source, target, name, fact, metadata, source_ids, claim['effective_at']))
            all_claims[cid] = {'fact':fact, 'sources':source_ids, 'group':group}
        local_claims = {c['id']:stable_id(rid,c['id']) for c in result['attributes'] + result['relations']}
        for index, change in enumerate(result['changes']):
            new_id = local_claims[change['new_claim_id']]
            old_id = local_claims.get(change['old_claim_id'], change['old_claim_id'])
            old = all_claims.get(old_id)
            if not old or old['group'] != group:
                raise ValueError('Change outside authorized evidence partition')
            source_ids = list(dict.fromkeys([e['message_id'] for e in change['evidence']] + old['sources'] + all_claims[new_id]['sources']))
            name = '明确纠正候选' if change['kind'] == 'explicit_correction' else '修改请求候选'
            fact = name + '：先前「' + old['fact'] + '」；后续「' + all_claims[new_id]['fact'] + '」。保留原记录，不代表公司确认。'
            edges.append(edge_plan(stable_id(rid,'change',str(index)),new_id,old_id,name,fact,change,source_ids))
        plans.append({'record_id':rid,'group':group,'episode':episode,'nodes':nodes,'edges':edges,
                      'occurred_at':data['messages'][0]['occurred_at'],
                      'content':episode_content(data['messages'], speakers)})
    return plans


def graph_projection(persisted_nodes, persisted_edges, source_map):
    """Build a public DTO only from objects read back from Graphiti storage."""
    def key(group, uuid):
        return group + ':' + uuid
    nodes, edges = {}, []
    for item in persisted_nodes:
        group, attrs = item['group'], item['attributes']
        origin = 'crm' if group == 'crm' else 'claim' if 'Claim' in item['labels'] else 'candidate'
        sources = [] if origin == 'crm' else json.loads(attrs.get('source_ids_json', '[]'))
        if any(s not in source_map or source_group(source_map[s]) != group for s in sources):
            raise ValueError('Invalid node provenance')
        public_attrs = json.loads(attrs['crm_json']) if origin == 'crm' else json.loads(attrs['claim_json']) if 'claim_json' in attrs else {
            k:v for k,v in attrs.items() if k != 'source_ids_json'
        }
        node_key = key(group, item['uuid'])
        nodes[node_key] = {'key':node_key, 'id':item['uuid'], 'group':group, 'name':item['name'],
            'labels':item['labels'], 'origin':origin, 'object_id':attrs.get('object_id') or None,
            'attributes':public_attrs, 'source_ids':sources,
            'record_ids':list(dict.fromkeys(source_map[s]['record_id'] for s in sources))}
    for item in persisted_edges:
        group, attrs = item['group'], item['attributes']
        sources = [] if group == 'crm' else json.loads(attrs['source_ids_json'])
        if any(s not in source_map or source_group(source_map[s]) != group for s in sources):
            raise ValueError('Invalid edge provenance')
        claim = json.loads(attrs.get('claim_json', '{}'))
        kind = 'crm_relationship' if group == 'crm' else claim.get('kind') if 'new_claim_id' in claim else 'attribute_candidate' if 'entity_ref' in claim else 'relation_candidate'
        source, target = key(group,item['source']), key(group,item['target'])
        if source not in nodes or target not in nodes:
            raise ValueError('Missing persisted graph endpoint')
        edges.append({'key':key(group,item['uuid']), 'id':item['uuid'], 'group':group,
            'source':source, 'target':target, 'label':item['name'], 'fact':item['fact'], 'kind':kind,
            'valid_at':item['valid_at'], 'invalid_at':item['invalid_at'], 'source_ids':sources,
            'record_ids':list(dict.fromkeys(source_map[s]['record_id'] for s in sources)),
            'project_id':source_map[sources[0]]['project_id'] if sources else None,
            'trust':source_map[sources[0]]['trust'] if sources else None})
        for endpoint in (source,target):
            node = nodes[endpoint]
            node['source_ids'] = list(dict.fromkeys(node['source_ids'] + sources))
            node['record_ids'] = list(dict.fromkeys(node['record_ids'] + [source_map[s]['record_id'] for s in sources]))
    return {'nodes':sorted(nodes.values(),key=lambda n:n['key']), 'edges':sorted(edges,key=lambda e:e['key'])}


def expected_group_sizes(snapshot, plans):
    """An Episode with no extracted facts is valid, including its empty partition."""
    sizes = {'crm': [len(snapshot['entities']), len(snapshot['relationships'])]}
    for plan in plans:
        size = sizes.setdefault(plan['group'], [0, 0])
        size[0] += len(plan['nodes'])
        size[1] += len(plan['edges'])
    return sizes


async def run(job):
    from fastembed import TextEmbedding
    from redislite.async_falkordb_client import AsyncFalkorDB
    from graphiti_core.driver.falkordb_driver import FalkorDriver
    from graphiti_core.nodes import EntityNode, EpisodicNode, EpisodeType
    from graphiti_core.edges import EntityEdge, EpisodicEdge
    from graphiti_core.embedder.client import EmbedderClient

    snapshot = job['snapshot']
    workspace, customer = str(UUID(snapshot['workspace_id'])), str(UUID(snapshot['customer_id']))
    UUID(snapshot['actor_id'])
    root = Path(os.environ['GRAPHITI_DATA_DIR']).resolve()
    directory = root / workspace / customer / str(UUID(job['generation']))
    directory.mkdir(parents=True, exist_ok=False, mode=0o700)
    plans = project_records(job['records'])
    source_map = {s['id']:s for s in snapshot['sources']}
    model = TextEmbedding(MODEL, cache_dir=str(root / 'models'), threads=2, local_files_only=True)
    class LocalEmbedder(EmbedderClient):
        async def create(self, input_data):
            text = input_data if isinstance(input_data, str) else ' '.join(input_data)
            return (await self.create_batch([text]))[0]
        async def create_batch(self, input_data_list):
            return await asyncio.to_thread(lambda: [v.tolist() for v in model.embed(input_data_list)])
    embedder = LocalEmbedder()
    client = AsyncFalkorDB(dbfilename=str(directory / 'graph.rdb'), serverconfig={'port':'0'})
    def timestamp(value):
        return datetime.fromisoformat(value.replace('Z','+00:00')) if value else None
    manifest = {'schema':snapshot['schema']['revision'],'protocol':job['protocol'],
                'sources':[fingerprint(s) for s in snapshot['sources']],
                'episodes':{p['record_id']:p['episode'] for p in plans}}
    try:
        # Authoritative CRM properties remain in their separate graph. Canonical
        # candidate entities reuse the exact CRM UUID without modifying CRM values.
        canonical = FalkorDriver(falkor_db=client, database='crm')
        await canonical.build_indices_and_constraints()
        for entity in snapshot['entities']:
            node = EntityNode(uuid=entity['id'], name=entity['name'], group_id='crm',
                labels=['Entity', {'customers':'Company','people':'Person','projects':'Project'}.get(entity['object'],'Custom')],
                attributes={'crm_json':json.dumps(entity['attributes'],ensure_ascii=False),
                            'object_id':entity['object'],
                            'schema_revision':snapshot['schema']['revision']})
            await node.generate_name_embedding(embedder)
            await node.save(canonical)
        definitions = {r['id']:r for r in snapshot['schema']['relationships'] + snapshot['schema'].get('references', [])}
        for relation in snapshot['relationships']:
            definition = definitions[relation['definition_id']]
            edge = EntityEdge(uuid=relation['id'],group_id='crm',source_node_uuid=relation['source_id'],
                target_node_uuid=relation['target_id'],name=definition['source_label'],
                fact=json.dumps(definition,ensure_ascii=False),attributes={'definition_id':definition['id']},
                created_at=datetime.now(timezone.utc))
            await edge.generate_embedding(embedder)
            await edge.save(canonical)
        drivers = {}
        for plan in plans:
            group = plan['group']
            if group not in drivers:
                drivers[group] = FalkorDriver(falkor_db=client,database=group)
                await drivers[group].build_indices_and_constraints()
            driver = drivers[group]
            episode = EpisodicNode(uuid=plan['episode'],name=plan['record_id'],group_id=group,
                source=EpisodeType.text, source_description='Whitespace-normalized CRM Record messages; originals remain in CRM; not company approval',
                content=plan['content'],valid_at=timestamp(plan['occurred_at']),
                entity_edges=[e['uuid'] for e in plan['edges']])
            await episode.save(driver)
            for item in plan['nodes']:
                node = EntityNode(uuid=item['uuid'],name=item['name'],group_id=group,
                    labels=['Entity',item['label']],attributes=item['attributes'])
                await node.generate_name_embedding(embedder)
                await node.save(driver)
                await EpisodicEdge(uuid=stable_id(plan['episode'],item['uuid']),group_id=group,
                    source_node_uuid=episode.uuid,target_node_uuid=node.uuid,created_at=datetime.now(timezone.utc)).save(driver)
            for item in plan['edges']:
                edge = EntityEdge(uuid=item['uuid'],group_id=group,source_node_uuid=item['source'],
                    target_node_uuid=item['target'],name=item['name'],fact=item['fact'],episodes=[episode.uuid],
                    valid_at=timestamp(item['valid_at']),invalid_at=None,attributes=item['attributes'],
                    created_at=datetime.now(timezone.utc))
                await edge.generate_embedding(embedder)
                await edge.save(driver)
        # Read back persisted Graphiti edges, not the in-memory projection plan.
        facts, persisted_nodes, persisted_edges = [], [], []
        expected_sizes = expected_group_sizes(snapshot, plans)
        for group, driver in {'crm':canonical, **drivers}.items():
            # Graphiti raises Groups{Nodes,Edges}NotFoundError for an empty list.
            # Skip only an expected empty set; a missing nonempty set must fail.
            stored_nodes = await EntityNode.get_by_group_ids(driver,[group]) if expected_sizes[group][0] else []
            stored_edges = await EntityEdge.get_by_group_ids(driver,[group]) if expected_sizes[group][1] else []
            for node in stored_nodes:
                persisted_nodes.append({'uuid':node.uuid,'name':node.name,'group':group,
                    'labels':node.labels,'attributes':node.attributes})
            for edge in stored_edges:
                persisted_edges.append({'uuid':edge.uuid,'group':group,'source':edge.source_node_uuid,
                    'target':edge.target_node_uuid,'name':edge.name,'fact':edge.fact,
                    'valid_at':edge.valid_at.isoformat() if edge.valid_at else None,
                    'invalid_at':edge.invalid_at.isoformat() if edge.invalid_at else None,
                    'attributes':edge.attributes})
                if group == 'crm':
                    continue
                ids = json.loads(edge.attributes['source_ids_json'])
                if not ids or any(i not in source_map for i in ids):
                    raise ValueError('Invalid graph provenance')
                first = source_map[ids[0]]
                if any(source_group(source_map[i]) != group for i in ids):
                    raise ValueError('Mixed graph provenance')
                facts.append({'id':edge.uuid,'fact':edge.fact,'relation':edge.name,
                    'valid_at':edge.valid_at.isoformat() if edge.valid_at else None,
                    'invalid_at':edge.invalid_at.isoformat() if edge.invalid_at else None,
                    'source_ids':ids,'project_id':first['project_id'],'trust':first['trust']})
        facts.sort(key=lambda f:(max(source_map[s]['occurred_at'] for s in f['source_ids']),f['id']),reverse=True)
        await client.client.save()
        (directory / 'manifest.json').write_text(json.dumps(manifest))
        return {'facts':facts, 'graph':graph_projection(persisted_nodes,persisted_edges,source_map)}
    finally:
        try:
            await client.client.shutdown(save=True)
        finally:
            await client.close()


if __name__ == '__main__':
    try:
        job = json.load(sys.stdin)
        # Third-party logs can contain source text; never emit them to CRM logs.
        with open(os.devnull, 'w') as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            if '--discard' in sys.argv:
                discard(job)
                result = {'discarded':True}
            else:
                async def bounded_run():
                    return await asyncio.wait_for(run(job), timeout=14*60)
                result = asyncio.run(bounded_run())
        print(json.dumps(result, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'error':'Graphiti execution failed', 'code':type(error).__name__}))
        sys.exit(1)
