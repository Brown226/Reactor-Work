"""Query the offline GEN NX API contracts. No software connection or network access."""
from __future__ import annotations

import argparse
from contextlib import closing
import json
from pathlib import Path
import re
import sqlite3
import sys

from PKPMAgent.skill_kit.vault import connect_db

DB_PATH = Path(__file__).resolve().parents[1] / 'references' / 'midas_api.db'
JSON_FIELDS = ('methods', 'parameters', 'reference_tables', 'schemas', 'examples', 'see_also')


def connection(path=DB_PATH):
    conn = connect_db(path)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA query_only=ON')
    return conn


def rows(conn, sql, params=()):
    result = [dict(r) for r in conn.execute(sql, params)]
    for r in result:
        for field in JSON_FIELDS:
            if field in r:
                r[field] = json.loads(r[field])
    return result


def listing(total, items, offset):
    following = offset + len(items)
    return {'total': total, 'returned': len(items),
            'next_offset': following if items and following < total else None, 'items': items}


def related_interfaces(conn, links, product):
    """Resolve source cross-references to the same offline navigation as search."""
    result, seen = [], set()
    for link in links:
        source = re.search(r'/articles/(\d+)', link['url'])
        matches = rows(conn, f'''SELECT m.path AS module,e.name,e.path,e.methods
                       FROM endpoints e JOIN modules m ON m.id=e.module_id
                       WHERE e.source_id=? AND {product} ORDER BY m.path,e.name''',
                       (source[1],)) if source else []
        if not matches:
            result.append({'title': link['title'], 'available_offline': False})
        for match in matches:
            key = (match['module'], match['name'])
            if key not in seen:
                seen.add(key)
                result.append(match)
    return result


def search_keyword(keyword):
    keyword = ' '.join(keyword.casefold().split())
    if not keyword or re.search(r'[\u3400-\u9fff]', keyword):
        raise ValueError('search 请使用英文关键词、接口名或 REST 路径，例如 "Pressure Load" 或 /db/PRES；'
                         '不确定英文名称时用 modules/endpoints 浏览目录。')
    return keyword


def search_interfaces(conn, keyword, product):
    term = search_keyword(keyword)
    tokens = term.split()
    found = {}
    for entry in rows(conn, f'''SELECT e.name,e.path,e.methods,m.path AS module,
                         e.purpose,e.parameters,e.remarks FROM endpoints e
                         JOIN modules m ON m.id=e.module_id WHERE {product}'''):
        fields = {key: (json.dumps(entry[key], ensure_ascii=False) if isinstance(entry[key], list)
                       else entry[key] or '').casefold() for key in ('name','path','purpose','parameters','remarks')}
        score = None
        if fields['path'] == term or fields['name'] == term:
            score = 0
        elif term.startswith('/'):
            if fields['path'].startswith(term):
                score = 2
        elif term in fields['name']:
            score = 1
        elif len(tokens) > 1 and all(token in fields['name'] for token in tokens):
            score = 2
        else:
            for rank, field in enumerate(('purpose','remarks','parameters'), start=3):
                if term in fields[field]:
                    score = rank
                    break
        if score is not None:
            brief = {key: entry[key] for key in ('name','path','methods','module')}
            identity = (entry['module'], entry['name'], entry['path'])
            if identity not in found or score < found[identity][0]:
                found[identity] = (score, brief)
    ranked = sorted(found.values(), key=lambda item: (item[0], item[1]['name'], item[1]['path'], item[1]['module']))
    return [entry for _, entry in ranked]


def query(conn, args):
    product = '1=1' if args.all_products else "e.products != 'civil'"
    brief = 'e.name,e.path,e.methods,m.path AS module'
    base = 'endpoints e JOIN modules m ON m.id=e.module_id'
    if args.command == 'modules':
        return rows(conn, '''SELECT m.path,m.name FROM modules m LEFT JOIN modules p ON p.id=m.parent_id
                            WHERE p.path IS ? ORDER BY m.path''', (args.parent,))
    if args.command == 'endpoints':
        module_filter = 'm.path=?'
        params = [args.module]
        if getattr(args, 'recursive', False):
            module_filter = '(m.path=? OR substr(m.path,1,?)=?)'
            params.extend([len(args.module)+1, args.module+'/'])
        where = f'{product} AND {module_filter}'
        total = conn.execute(f'SELECT count(*) FROM {base} WHERE {where}', params).fetchone()[0]
        items = rows(conn, f'''SELECT {brief} FROM {base} WHERE {where}
                    ORDER BY e.path,e.name,e.source_id LIMIT ? OFFSET ?''',
                     (*params, -1 if args.limit is None else args.limit, args.offset))
        result = listing(total, items, args.offset)
        if not total:
            result['next'] = '本层无接口时用 modules <模块路径> 继续查看子模块。'
        return result
    if args.command == 'search':
        found = search_interfaces(conn, args.keyword, product)
        end = None if args.limit is None else args.offset + args.limit
        return listing(len(found), found[args.offset:end], args.offset)
    if args.command == 'detail':
        conditions, values = [product], []
        if args.name:
            conditions.extend(['m.path=? COLLATE NOCASE', 'e.name=? COLLATE NOCASE'])
            values.extend([args.target, args.name])
        else:
            conditions.append('e.path=? COLLATE NOCASE'); values.append(args.target)
        if args.method:
            conditions.append('EXISTS(SELECT 1 FROM json_each(e.methods) WHERE value=?)'); values.append(args.method)
        found = rows(conn, f"SELECT e.*,m.path AS module FROM {base} WHERE {' AND '.join(conditions)} ORDER BY e.name", values)
        if len(found) != 1:
            return {'matches': len(found),
                    'items': [{k:e[k] for k in ('module','name','path','methods')} for e in found],
                    'next': ('从列表选择 module 和 name，执行 detail "<module>" "<name>"。' if found else
                             '未找到接口。用 endpoints "<模块路径>" 或 search "<关键词>" 获取准确的模块与接口名称。')}
        e = found[0]
        result = {k:e[k] for k in ('name','module','path','methods','products')}
        if e['see_also']:
            result['related_interfaces'] = related_interfaces(conn, e['see_also'], product)
        if not e['methods']:
            result['warning'] = '官方未注明 HTTP 方法，不能推定支持 CRUD。'
        if e['purpose']:
            result['purpose'] = e['purpose']
        if args.section == 'summary':
            result['parameters_count'] = sum(p.get('kind')=='parameter' for p in e['parameters'])
            for kind in ('schemas','examples'):
                result[kind] = [{k:b[k] for k in ('id','title','parse_error')} for b in e[kind]]
            result['remarks'] = e['remarks']
        elif args.section == 'parameters':
            result['parameters'] = e['parameters']
            result['reference_tables'] = e['reference_tables']
            result['remarks'] = e['remarks']
        elif args.section in ('schema','examples'):
            key = 'schemas' if args.section=='schema' else 'examples'
            result[key] = [b for b in e[key] if not args.block or args.block.lower() in (b['id']+' '+b['title']).lower()]
            result['remarks'] = e['remarks']
        else:
            result.update({k:e[k] for k in ('parameters','reference_tables','schemas','examples','remarks')})
        return result
    raise ValueError(args.command)


def render(value):
    if isinstance(value, list):
        return '\n'.join(' | '.join(f'{k}: {v}' for k,v in r.items() if v not in (None,'')) for r in value)
    output = []
    for key, data in value.items():
        if key in ('schemas','examples'):
            for b in data:
                output.append(f"\n{b['id']} | {b['title']}")
                if b['parse_error']:
                    output.append('原文 JSON 有误，不能直接执行：'+b['parse_error'])
                if 'code' in b:
                    output.append('```'+b.get('language','json')+'\n'+b['code']+'\n```')
        elif key == 'parameters':
            for p in data:
                output.append('\n'+' | '.join(f'{k}: {v}' for k,v in p.items() if k not in ('kind','section')))
        elif key == 'reference_tables':
            for table in data:
                output.append('\n'+table['section'])
                output.extend(' | '.join(c.replace('\n',' / ') for c in row) for row in table['rows'])
        elif isinstance(data,list) and all(isinstance(v,dict) for v in data):
            output.append(key+':\n'+render(data))
        else:
            output.append(f'{key}: '+(json.dumps(data,ensure_ascii=False) if isinstance(data,(dict,list)) else str(data)))
    return '\n'.join(output)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--json', action='store_true')
    p.add_argument('--all-products', action='store_true', help='包含明确 CIVIL 专属接口')
    subs = p.add_subparsers(dest='command', required=True)
    modules = subs.add_parser('modules'); modules.add_argument('parent', nargs='?')
    endpoints = subs.add_parser('endpoints'); endpoints.add_argument('module')
    endpoints.add_argument('--recursive', action='store_true', help='包含全部子模块；endpoints DB --recursive 列出 DB 接口目录')
    search = subs.add_parser('search', help='用英文关键词、接口名或 REST 路径检索')
    search.add_argument('keyword', help='英文检索词，例如 "Pressure Load" 或 /db/PRES')
    for sub in (endpoints,search):
        sub.add_argument('--limit', type=int, default=20 if sub is search else None,
                         help='单次返回条数；模块接口默认全部，关键词搜索默认 20')
        sub.add_argument('--offset', type=int, default=0, help='跳过前 N 条，从 next_offset 继续读取')
    detail = subs.add_parser('detail', help='按模块路径和接口名称取详情，也可直接查询已知 REST 路径')
    detail.add_argument('target', help='模块路径；省略 name 时须为 /db/NODE 这样的 REST 路径')
    detail.add_argument('name', nargs='?', help='endpoints 或 search 返回的完整接口名称')
    detail.add_argument('--method', choices=('GET','POST','PUT','DELETE','PATCH'))
    detail.add_argument('--block', help='概览中返回的示例/Schema 代码块名称或编号')
    detail.add_argument('--section', default='summary', choices=('summary','parameters','schema','examples','all'))
    args = p.parse_args(argv)
    if args.command == 'search':
        try:
            search_keyword(args.keyword)
        except ValueError as exc:
            p.error(str(exc))
    if args.command=='detail' and not args.name and not args.target.startswith('/'):
        p.error('detail 需要模块路径和接口名称，例如 detail "DB/Node/Element" "Node"')
    if (getattr(args,'limit',None) is not None and args.limit<=0) or getattr(args,'offset',0)<0:
        p.error('limit 必须为正，offset 不能为负')
    with closing(connection()) as conn:
        result = query(conn,args)
    print(json.dumps(result,ensure_ascii=False,indent=2) if args.json else render(result))


if __name__ == '__main__':
    if hasattr(sys.stdout,'reconfigure'):
        sys.stdout.reconfigure(encoding='utf8')
    main()
