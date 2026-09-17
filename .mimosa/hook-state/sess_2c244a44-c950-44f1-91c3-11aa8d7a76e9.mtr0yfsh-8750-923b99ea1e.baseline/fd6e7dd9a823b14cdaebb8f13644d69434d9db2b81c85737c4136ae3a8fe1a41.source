#!/usr/bin/env python3
"""
Dataset Converter for Web Agent Eval System

Converts benchmark datasets (WebVoyager, Mind2Web) to unified JSONL format.

Usage:
    python converter.py webvoyager <input_data.jsonl> <output.jsonl> [--reference <reference_answer.json>]
    python converter.py mind2web <input_data.json> <output.jsonl>
    python converter.py online-mind2web <input_data.json> <output.jsonl>

Output format (one JSON per line):
{
    "query_id": "unique-id",
    "dataset": "webvoyager|mind2web|online-mind2web",
    "query": "task instruction",
    "graders": ["webvoyager_grader"],
    "start_url": "https://...",
    "metadata": {
        "original_task_id": "...",
        "website": "...",
        "category": "...",
        "additional": {...}
    }
}
"""

import json
import argparse
import sys
from pathlib import Path
from typing import Optional


def convert_webvoyager(
    input_path: str,
    output_path: str,
    reference_path: Optional[str] = None
) -> int:
    """
    Convert WebVoyager dataset to unified format.

    WebVoyager format (JSONL):
    {"web_name": "Allrecipes", "id": "Allrecipes--0", "ques": "...", "web": "https://..."}

    Reference answers format (JSON):
    {
        "Allrecipes": {
            "answers": [{"id": 0, "type": "golden", "ans": "..."}]
        }
    }
    """
    # Load reference answers if provided
    reference_answers = {}
    if reference_path:
        with open(reference_path, 'r', encoding='utf-8') as f:
            ref_data = json.load(f)
            for website, data in ref_data.items():
                if 'answers' in data:
                    for ans in data['answers']:
                        key = f"{website}--{ans['id']}"
                        reference_answers[key] = {
                            'answer': ans.get('ans'),
                            'type': ans.get('type', 'unknown')
                        }

    count = 0
    with open(input_path, 'r', encoding='utf-8') as infile, \
         open(output_path, 'w', encoding='utf-8') as outfile:

        for line_num, line in enumerate(infile, 1):
            line = line.strip()
            if not line:
                continue

            try:
                data = json.loads(line)
            except json.JSONDecodeError as e:
                print(f"Warning: Skipping line {line_num}, invalid JSON: {e}", file=sys.stderr)
                continue

            task_id = data.get('id', f'webvoyager-{line_num}')

            # Build unified format
            unified = {
                'query_id': task_id,
                'dataset': 'webvoyager',
                'query': data.get('ques', ''),
                'graders': ['webvoyager_grader'],
                'start_url': data.get('web'),
                'metadata': {
                    'original_task_id': task_id,
                    'website': data.get('web_name'),
                    'category': data.get('web_name'),  # WebVoyager uses website as category
                }
            }

            # Add reference answer if available
            if task_id in reference_answers:
                unified['metadata']['additional'] = {
                    'ground_truth': reference_answers[task_id]['answer'],
                    'answer_type': reference_answers[task_id]['type']
                }

            outfile.write(json.dumps(unified, ensure_ascii=False) + '\n')
            count += 1

    return count


def convert_mind2web(input_path: str, output_path: str) -> int:
    """
    Convert Mind2Web dataset to unified format.

    Mind2Web format (JSON array or JSONL):
    {
        "annotation_id": "unique-id",
        "website": "website-name",
        "domain": "domain",
        "subdomain": "subdomain",
        "confirmed_task": "task description",
        "action_reprs": ["action1", "action2", ...]
    }
    """
    # Try loading as JSON array first, fall back to JSONL
    tasks = []
    with open(input_path, 'r', encoding='utf-8') as f:
        content = f.read().strip()
        if content.startswith('['):
            # JSON array
            tasks = json.loads(content)
        else:
            # JSONL
            for line in content.split('\n'):
                if line.strip():
                    tasks.append(json.loads(line))

    count = 0
    with open(output_path, 'w', encoding='utf-8') as outfile:
        for task in tasks:
            task_id = task.get('annotation_id', f'mind2web-{count}')
            website = task.get('website', '')

            # Extract start URL from website field or construct from domain
            start_url = None
            if website.startswith('http'):
                start_url = website
            elif task.get('domain'):
                start_url = f"https://{task.get('domain')}"

            unified = {
                'query_id': task_id,
                'dataset': 'mind2web',
                'query': task.get('confirmed_task', ''),
                'graders': ['mind2web_judge'],
                'start_url': start_url,
                'metadata': {
                    'original_task_id': task_id,
                    'website': website,
                    'category': task.get('domain'),
                    'additional': {
                        'subdomain': task.get('subdomain'),
                        'action_reprs': task.get('action_reprs', []),
                        'reference_length': len(task.get('actions', []))
                    }
                }
            }

            outfile.write(json.dumps(unified, ensure_ascii=False) + '\n')
            count += 1

    return count


def convert_online_mind2web(input_path: str, output_path: str) -> int:
    """
    Convert Online-Mind2Web dataset to unified format.

    Online-Mind2Web format:
    {
        "task_id": "unique-id",
        "website": "https://...",
        "confirmed_task": "task description",
        "level": "easy|medium|hard",
        "reference_length": 5
    }
    """
    # Try loading as JSON array first, fall back to JSONL
    tasks = []
    with open(input_path, 'r', encoding='utf-8') as f:
        content = f.read().strip()
        if content.startswith('['):
            tasks = json.loads(content)
        else:
            for line in content.split('\n'):
                if line.strip():
                    tasks.append(json.loads(line))

    count = 0
    with open(output_path, 'w', encoding='utf-8') as outfile:
        for task in tasks:
            task_id = task.get('task_id', f'online-mind2web-{count}')

            unified = {
                'query_id': task_id,
                'dataset': 'online-mind2web',
                'query': task.get('confirmed_task', ''),
                'graders': ['mind2web_judge'],
                'start_url': task.get('website'),
                'metadata': {
                    'original_task_id': task_id,
                    'website': task.get('website'),
                    'category': task.get('level', 'unknown'),
                    'additional': {
                        'level': task.get('level'),
                        'reference_length': task.get('reference_length')
                    }
                }
            }

            outfile.write(json.dumps(unified, ensure_ascii=False) + '\n')
            count += 1

    return count


def main():
    parser = argparse.ArgumentParser(
        description='Convert benchmark datasets to unified JSONL format',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )

    subparsers = parser.add_subparsers(dest='dataset', required=True)

    # WebVoyager subcommand
    wv_parser = subparsers.add_parser('webvoyager', help='Convert WebVoyager dataset')
    wv_parser.add_argument('input', help='Input JSONL file (WebVoyager_data.jsonl)')
    wv_parser.add_argument('output', help='Output JSONL file')
    wv_parser.add_argument('--reference', '-r', help='Reference answers JSON file')

    # Mind2Web subcommand
    m2w_parser = subparsers.add_parser('mind2web', help='Convert Mind2Web dataset')
    m2w_parser.add_argument('input', help='Input JSON/JSONL file')
    m2w_parser.add_argument('output', help='Output JSONL file')

    # Online-Mind2Web subcommand
    om2w_parser = subparsers.add_parser('online-mind2web', help='Convert Online-Mind2Web dataset')
    om2w_parser.add_argument('input', help='Input JSON/JSONL file')
    om2w_parser.add_argument('output', help='Output JSONL file')

    args = parser.parse_args()

    # Validate input file exists
    if not Path(args.input).exists():
        print(f"Error: Input file not found: {args.input}", file=sys.stderr)
        sys.exit(1)

    # Create output directory if needed
    output_dir = Path(args.output).parent
    if output_dir and not output_dir.exists():
        output_dir.mkdir(parents=True, exist_ok=True)

    # Convert based on dataset type
    if args.dataset == 'webvoyager':
        reference = getattr(args, 'reference', None)
        count = convert_webvoyager(args.input, args.output, reference)
    elif args.dataset == 'mind2web':
        count = convert_mind2web(args.input, args.output)
    elif args.dataset == 'online-mind2web':
        count = convert_online_mind2web(args.input, args.output)
    else:
        print(f"Unknown dataset: {args.dataset}", file=sys.stderr)
        sys.exit(1)

    print(f"Converted {count} tasks to {args.output}")


if __name__ == '__main__':
    main()
