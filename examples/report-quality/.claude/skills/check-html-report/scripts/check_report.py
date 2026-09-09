#!/usr/bin/env python3
"""Check actual report files. Python 3 standard library only; never execute HTML."""
import argparse
from decimal import Decimal, InvalidOperation
import hashlib
from html.parser import HTMLParser
import json
import math
import os
from pathlib import Path
import re
import sys

SCRIPT = '.claude/skills/check-html-report/scripts/check_report.py'
MAX_FILE_BYTES = 2 * 1024 * 1024
PLACEHOLDERS = {'null', 'undefined', 'nan', 'infinity', '-infinity', 'todo', 'tbd', '待补充', '待填写', '占位'}
VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}


def normalized(value):
    return ' '.join(str(value).split())


class Node:
    def __init__(self, tag='', attrs=None, parent=None):
        self.tag, self.attrs, self.parent = tag, dict(attrs or []), parent
        self.children = []

    def descendants(self, tag=None):
        for child in self.children:
            if isinstance(child, Node):
                if tag is None or child.tag == tag:
                    yield child
                yield from child.descendants(tag)

    def hidden(self):
        node = self
        while node:
            style = re.sub(r'\s+', '', node.attrs.get('style', '')).lower()
            if ('hidden' in node.attrs or node.attrs.get('aria-hidden', '').lower() == 'true'
                    or 'display:none' in style or 'visibility:hidden' in style):
                return True
            node = node.parent
        return False

    def text(self, include_style=False):
        if not include_style and (self.tag in {'script', 'style', 'template'} or self.hidden()):
            return ''
        return normalized(' '.join(child.text(include_style) if isinstance(child, Node) else child
                                   for child in self.children))


class Document(HTMLParser):
    def __init__(self, content):
        super().__init__(convert_charrefs=True)
        self.root = Node()
        self.stack = [self.root]
        self.feed(content)
        self.close()

    def handle_starttag(self, tag, attrs):
        node = Node(tag, [(key, value or '') for key, value in attrs], self.stack[-1])
        self.stack[-1].children.append(node)
        if tag not in VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                self.stack = self.stack[:index]
                return

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def indexed(root, attribute):
    result = {}
    for node in root.descendants():
        if attribute in node.attrs and not node.hidden():
            result.setdefault(node.attrs[attribute], []).append(node)
    return result


def nearest(node, tag):
    node = node.parent
    while node:
        if node.tag == tag:
            return node
        node = node.parent
    return None


def expand_grid(rows, value_of=lambda cell: cell.text()):
    grid, carry = [], {}
    for row in rows:
        occupied = {column: text for column, (text, _) in carry.items()}
        following = {column: (text, remaining - 1) for column, (text, remaining) in carry.items() if remaining > 1}
        column = 0
        cells = [child for child in row.children if isinstance(child, Node) and child.tag in {'th', 'td'}]
        for cell in cells:
            try:
                colspan = int(cell.attrs.get('colspan', '1'))
                rowspan = int(cell.attrs.get('rowspan', '1'))
            except ValueError as error:
                raise ValueError('Invalid table span') from error
            if not 1 <= colspan <= 1000 or not 1 <= rowspan <= 1000:
                raise ValueError('Table span is out of range')
            while column in occupied:
                column += 1
            if any(index in occupied for index in range(column, column + colspan)):
                raise ValueError('Overlapping table spans')
            for index in range(column, column + colspan):
                occupied[index] = value_of(cell)
                if rowspan > 1:
                    following[index] = (value_of(cell), rowspan - 1)
            column += colspan
        width = max(occupied, default=-1) + 1
        if width > 1000 or any(index not in occupied for index in range(width)):
            raise ValueError('Incomplete table row grid')
        grid.append([occupied[index] for index in range(width)])
        carry = following
    if carry:
        raise ValueError('Table rowspan extends beyond its row group')
    return grid


def table_content(table):
    rows = [row for row in table.descendants('tr') if nearest(row, 'table') is table and not row.hidden()]
    headers = [row for row in rows if nearest(row, 'thead') is not None]
    if not headers and rows:
        first_cells = [child for child in rows[0].children if isinstance(child, Node) and child.tag in {'th', 'td'}]
        if first_cells and all(cell.tag == 'th' for cell in first_cells):
            headers = [rows[0]]
    if not headers:
        raise ValueError('Table needs a visible header row')
    header_grid = expand_grid(headers)
    width = len(header_grid[0])
    if not width or any(len(row) != width for row in header_grid):
        raise ValueError('Header rows have different logical widths')
    names = []
    for column in range(width):
        parts = []
        for row in header_grid:
            if row[column] not in parts:
                parts.append(row[column])
        names.append(' / '.join(parts))
    body = expand_grid([row for row in rows if row not in headers])
    if any(len(row) != width for row in body):
        raise ValueError('Data row width does not match the header')
    return names, body


def data_rows(table):
    rows = [row for row in table.descendants('tr') if nearest(row, 'table') is table and not row.hidden()]
    headers = [row for row in rows if nearest(row, 'thead') is not None]
    if not headers and rows:
        headers = [rows[0]]
    return [row for row in rows if row not in headers]


def layout_signature(node, dynamic_text=False, ignore_spans=False, allowed_empty=frozenset()):
    """Preserve static DOM/CSS placement; only explicitly bound values may vary."""
    attrs = tuple(sorted((key, value) for key, value in node.attrs.items()
                         if not (ignore_spans and key in {'rowspan', 'colspan'})))
    if node.attrs.get('data-empty-for') in allowed_empty:
        return None
    dynamic_text = dynamic_text or 'data-field' in node.attrs or node.tag in {'title', 'h1'}
    parent_table = nearest(node, 'table')
    dynamic_group = node.tag in {'tbody', 'tfoot'} and parent_table and 'data-table' in parent_table.attrs
    direct_data = set(data_rows(node)) if node.tag == 'table' and 'data-table' in node.attrs else set()
    children = []
    if dynamic_group:
        children.append(('bound-data-rows',))
    inserted_rows = False
    for child in node.children:
        if isinstance(child, Node):
            if dynamic_group and child.tag == 'tr':
                continue
            if child in direct_data:
                if not inserted_rows:
                    children.append(('bound-data-rows',))
                    inserted_rows = True
                continue
            value = layout_signature(child, dynamic_text, ignore_spans, allowed_empty)
            if value is not None:
                children.append(value)
        elif not dynamic_text and normalized(child):
            children.append(('text', normalized(child)))
    return node.tag, attrs, tuple(children)


def row_templates_match(reference_table, report_table):
    reference_rows, report_rows = data_rows(reference_table), data_rows(report_table)
    if not report_rows:
        return True
    if not reference_rows:
        return False
    ref_grid = expand_grid(reference_rows, lambda cell: cell)
    current_grid = expand_grid(report_rows, lambda cell: cell)
    width = len(ref_grid[0])
    if any(len(row) != width for row in ref_grid + current_grid):
        return False
    row_attributes = {tuple(sorted(row.attrs.items())) for row in reference_rows}
    if any(tuple(sorted(row.attrs.items())) not in row_attributes for row in report_rows):
        return False
    patterns = [{layout_signature(row[column], True, True) for row in ref_grid} for column in range(width)]
    return all(layout_signature(cell, True, True) in patterns[column]
               for row in current_grid for column, cell in enumerate(row))


def valid_value(value):
    if isinstance(value, bool) or value is None:
        return False
    if isinstance(value, (int, float)):
        return not isinstance(value, float) or math.isfinite(value)
    return isinstance(value, str) and bool(normalized(value)) and normalized(value).lower() not in PLACEHOLDERS


def matches(actual, expected):
    if isinstance(expected, (int, float)) and not isinstance(expected, bool):
        try:
            number = Decimal(actual.replace(',', ''))
            return number.is_finite() and number == Decimal(str(expected))
        except InvalidOperation:
            return False
    return actual == normalized(expected)


def safe_path(root, relative):
    if not isinstance(relative, str) or not relative or Path(relative).is_absolute():
        raise ValueError('Configured file paths must be relative to the workspace')
    target = (root / relative).resolve()
    try:
        target.relative_to(root)
    except ValueError as error:
        raise ValueError('Configured file paths must stay inside the workspace') from error
    return target


def check(reference, report, source, result):
    def fail(category, message, location=''):
        result['checks'][category] = False
        result['issues'].append({'category': category, 'message': message, 'location': location})

    for tag in ['html', 'body', 'title', 'h1']:
        if not any(node.text() for node in report.descendants(tag)):
            fail('structure', 'Report is missing a nonempty ' + tag, tag)
    reference_sections = [node for node in reference.descendants('section') if node.attrs.get('id')]
    report_sections = [node for node in report.descendants('section') if node.attrs.get('id') and not node.hidden()]
    reference_ids = [node.attrs['id'] for node in reference_sections]
    report_ids = [node.attrs['id'] for node in report_sections]
    if not reference_ids:
        fail('structure', 'Reference must define section[id] anchors', 'reference')
    if report_ids != reference_ids or len(set(report_ids)) != len(report_ids):
        fail('structure', 'Report section IDs or order differ from the reference', 'section[id]')
    headings = lambda document: [(node.tag, node.text()) for node in document.descendants()
                                 if node.tag in {'h2', 'h3', 'h4', 'h5', 'h6'} and not node.hidden()]
    if headings(reference) != headings(report):
        fail('structure', 'Report section headings differ from the reference', 'headings')
    styles = lambda document: [node.text(True) for node in document.descendants('style')]
    if styles(reference) != styles(report):
        fail('structure', 'Reference CSS was removed or changed', 'style')
    classes = lambda document: {item for node in document.descendants() for item in node.attrs.get('class', '').split()}
    if classes(reference) != classes(report):
        fail('structure', 'Report CSS class names differ from the reference', 'class')
    for section in report_sections:
        if not section.text():
            fail('completeness', 'Empty report section', section.attrs['id'])

    if not isinstance(source, dict) or source.get('version') != 1 or not valid_value(source.get('title')):
        fail('data', 'Source must have version 1 and a nonempty title', 'source')
        return
    fields, tables = source.get('fields'), source.get('tables')
    if not isinstance(fields, dict) or not isinstance(tables, dict) or not (fields or tables):
        fail('data', 'Source must contain fields and tables objects with at least one entry', 'source')
        return
    allowed_empty = {key for key, value in tables.items()
                     if isinstance(value, dict) and value.get('rows') == [] and valid_value(value.get('emptyText'))}
    for node in report.descendants():
        if node.attrs.get('data-empty-for') in allowed_empty:
            if node.tag != 'p' or set(node.attrs) != {'data-empty-for'} or any(isinstance(child, Node) for child in node.children):
                fail('structure', 'An added empty-state explanation must be a plain p[data-empty-for]', 'data-empty-for')
    if layout_signature(reference, allowed_empty=allowed_empty) != layout_signature(report, allowed_empty=allowed_empty):
        fail('structure', 'Static DOM structure, attributes, styles, or text differ from the reference', 'layout')
    report_titles = list(report.descendants('h1'))
    if len(report_titles) != 1 or not matches(report_titles[0].text(), source['title']):
        fail('data', 'Report heading does not match the current source title', 'h1')
    html_titles = list(report.descendants('title'))
    if len(html_titles) != 1 or not matches(html_titles[0].text(), source['title']):
        fail('data', 'Document title does not match the current source title', 'title')
    ref_fields, report_fields = indexed(reference, 'data-field'), indexed(report, 'data-field')
    if set(ref_fields) - set(fields):
        fail('data', 'Current source omits fields required by the reference', 'source.fields')
    if set(report_fields) != set(fields):
        fail('completeness', 'Report data-field keys do not match current source fields', 'data-field')
    for key, expected in fields.items():
        nodes = report_fields.get(key, [])
        if len(nodes) != 1:
            fail('completeness', 'Required field is missing or duplicated', key)
            continue
        actual = nodes[0].text()
        if not valid_value(actual):
            fail('completeness', 'Required field is blank or a placeholder', key)
        if not valid_value(expected) or not matches(actual, expected):
            fail('data', 'Field does not match the current source', key)

    ref_tables, report_tables = indexed(reference, 'data-table'), indexed(report, 'data-table')
    if set(ref_tables) - set(tables):
        fail('data', 'Current source omits tables required by the reference', 'source.tables')
    if set(report_tables) != set(tables):
        fail('completeness', 'Report data-table keys do not match current source tables', 'data-table')
    for key, expected in tables.items():
        nodes = report_tables.get(key, [])
        if len(nodes) != 1 or nodes[0].tag != 'table':
            fail('completeness', 'Required table is missing or duplicated', key)
            continue
        if (not isinstance(expected, dict) or not isinstance(expected.get('headers'), list)
                or not expected['headers'] or not isinstance(expected.get('rows'), list)):
            fail('data', 'Source table needs headers and rows arrays', key)
            continue
        try:
            headers, rows = table_content(nodes[0])
            if key in ref_tables and headers != table_content(ref_tables[key][0])[0]:
                fail('structure', 'Table headers differ from the reference', key)
            if key in ref_tables and not row_templates_match(ref_tables[key][0], nodes[0]):
                fail('structure', 'Table row markup, attributes, or column formatting differ from the reference', key)
        except ValueError as error:
            fail('structure', str(error), key)
            continue
        all_cells = headers + [cell for row in rows for cell in row]
        if any(not valid_value(cell) for cell in all_cells):
            fail('completeness', 'Table has blank or placeholder cells', key)
        if headers != [normalized(value) for value in expected['headers']] or not all(valid_value(value) for value in expected['headers']):
            fail('data', 'Table headers do not match the current source', key)
        source_rows = expected['rows']
        if (any(not isinstance(row, list) or len(row) != len(headers) or not all(valid_value(cell) for cell in row) for row in source_rows)
                or len(rows) != len(source_rows)):
            fail('data', 'Table row count, width, or source cell values are invalid', key)
            continue
        for index, (actual_row, expected_row) in enumerate(zip(rows, source_rows)):
            if any(not matches(actual, wanted) for actual, wanted in zip(actual_row, expected_row)):
                fail('data', 'Table row does not match the current source', key + '/row/' + str(index + 1))
        if not source_rows:
            empty_nodes = indexed(report, 'data-empty-for').get(key, [])
            if not valid_value(expected.get('emptyText')) or len(empty_nodes) != 1 or not matches(empty_nodes[0].text(), expected['emptyText']):
                fail('completeness', 'Empty table requires the source-approved emptyText explanation', key)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', default='.ccui/report-quality.json')
    parser.add_argument('--session-id', required=True)
    parser.add_argument('--attempt-token', required=True)
    args = parser.parse_args()
    root = Path.cwd().resolve()
    result = {'version': 1, 'sessionId': args.session_id, 'attemptToken': args.attempt_token,
              'passed': False, 'checks': {'structure': True, 'completeness': True, 'data': True},
              'issues': [], 'fingerprints': {key: None for key in ['reference', 'report', 'source', 'config', 'checkerSkill', 'checkerScript']}}
    verdict = None
    try:
        config_path = safe_path(root, args.config)
        raw_config = config_path.read_bytes()
        if len(raw_config) > MAX_FILE_BYTES:
            raise ValueError('Config exceeds the 2 MiB checker limit')
        result['fingerprints']['config'] = hashlib.sha256(raw_config).hexdigest()
        config = json.loads(raw_config)
        if not isinstance(config, dict) or config.get('enabled') is not True:
            raise ValueError('Report quality config must be enabled')
        if not args.session_id.strip() or not args.attempt_token.strip():
            raise ValueError('session-id and attempt-token must be nonempty')
        file_names = {key: config[key] for key in ['reference', 'report', 'source', 'checkerSkill']}
        file_names['checkerScript'] = config.get('checkerScript', SCRIPT)
        input_paths = {key: safe_path(root, relative) for key, relative in file_names.items()}
        if input_paths['checkerScript'] != Path(__file__).resolve():
            raise ValueError('Configured checkerScript must be the script being executed')
        candidate_verdict = safe_path(root, config['verdict'])
        if candidate_verdict in set(input_paths.values()) | {config_path}:
            raise ValueError('Verdict path must not overwrite any input, configuration, skill, or checker file')
        # Assign only after canonical-path checks, so even a failed run cannot
        # write a verdict over a protected input via ./, ../, or a symlink alias.
        verdict = candidate_verdict
        files = {}
        for key in file_names:
            try:
                files[key] = input_paths[key].read_bytes()
                if len(files[key]) > MAX_FILE_BYTES:
                    raise ValueError('File exceeds the 2 MiB checker limit')
                result['fingerprints'][key] = hashlib.sha256(files[key]).hexdigest()
            except (OSError, ValueError):
                result['checks']['data' if key == 'source' else 'structure'] = False
                result['issues'].append({'category': 'data' if key == 'source' else 'structure', 'message': 'Required input file is missing, too large, or inaccessible', 'location': key})
        if len(files) == len(file_names) and all(value is not None for value in result['fingerprints'].values()):
            check(Document(files['reference'].decode('utf-8')).root,
                  Document(files['report'].decode('utf-8')).root,
                  json.loads(files['source']), result)
        result['passed'] = all(result['checks'].values()) and not result['issues']
    except (OSError, ValueError, KeyError, TypeError, RecursionError) as error:
        result['checks'] = {'structure': False, 'completeness': False, 'data': False}
        result['issues'].append({'category': 'input', 'message': str(error), 'location': 'configuration or input'})
    if verdict is not None:
        try:
            verdict.parent.mkdir(parents=True, exist_ok=True)
            temporary = verdict.with_name(verdict.name + '.tmp-' + str(os.getpid()))
            temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
            os.replace(temporary, verdict)
        except OSError as error:
            result['passed'] = False
            result['issues'].append({'category': 'output', 'message': 'Could not write verdict: ' + str(error)})
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    sys.exit(main())
