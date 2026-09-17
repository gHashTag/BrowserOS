"""
Build WebBench eval datasets (READ-only, no-auth) + BrowseComp sets.

WebBench: 6 files — full + 50-sample for 0/4, 1/4, 2/4 buckets (READ-only).
BrowseComp: 2 files — medium-hard (~50) and very-hard (~50).

Usage: python3 apps/eval/scripts/build-webbench-sets.py
"""
import csv
import json
import os
import random
import re
from collections import defaultdict
from urllib.parse import urlparse

random.seed(42)

DATA_DIR = "apps/eval/data/webbench"
OUT_DIR = "apps/eval/data"

AGENTS = [
    {"file": "anthropicfinal.csv", "eval_col": "Anthropic_Eval", "key": "anthropic_cua"},
    {"file": "skyvern2.0final.csv", "eval_col": "Skyvern2.0Eval", "key": "skyvern_2"},
    {"file": "skyvern2.0browserbasefinal.csv", "eval_col": "Browserbase_SkyvernEval", "key": "skyvern_bb"},
    {"file": "openaicuafinal.csv", "eval_col": "CUAEval", "key": "openai_cua"},
]

CONSTRAINT_SUFFIX = re.compile(
    r"\s*Only use https?://\S+ to achieve the task\..*$", re.DOTALL
)

# Only these keywords indicate actual auth requirements in READ tasks
# (exclude "publish" — it's almost always about finding published articles)
AUTH_KEYWORDS_STRICT = [
    "log in", "login", "sign in", "signin", "sign up", "signup",
    "your account", "your profile", "your wishlist", "your order",
    "your cart", "your dashboard", "your settings", "your subscription",
    "your inbox", "your message", "your review", "your playlist",
    "your favorites", "your saved", "your address", "your payment",
    "my account", "my profile", "my wishlist", "my order", "my cart",
    "my dashboard", "my settings", "my subscription", "my inbox",
]


def load_agent(agent):
    path = os.path.join(DATA_DIR, agent["file"])
    results = {}
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            try:
                task_id = int(row["ID"])
            except (ValueError, KeyError):
                continue
            eval_val = row.get(agent["eval_col"], "")
            results[task_id] = {
                "eval": eval_val,
                "difficulty": row.get("Difficulty", ""),
                "category": row.get("Category", ""),
                "task": row.get("Task", ""),
                "url": row.get("Starting URL", ""),
            }
    return results


def extract_domain(url):
    parsed = urlparse(url)
    host = parsed.hostname or ""
    return re.sub(r"^www\.", "", host)


def clean_query(task_text):
    return CONSTRAINT_SUFFIX.sub("", task_text).strip()


def needs_auth(task_text):
    task_lower = task_text.lower()
    for kw in AUTH_KEYWORDS_STRICT:
        if kw in task_lower:
            return True
    return False


def build_task_entry(tid, info, pass_count, agent_evals):
    domain = extract_domain(info["url"])
    return {
        "query_id": f"wb-{tid}",
        "dataset": "webbench",
        "query": clean_query(info["task"]),
        "start_url": info["url"],
        "metadata": {
            "original_task_id": f"wb-{tid}",
            "website": domain,
            "category": info["category"],
            "additional": {
                "webbench_id": tid,
                "difficulty": info["difficulty"],
                "pass_count_4": pass_count,
                "agent_results": agent_evals,
            },
        },
    }


def stratified_sample(tasks, n):
    """Sample n tasks with diversity across difficulty, category, and website (max 2 per domain)."""
    if len(tasks) <= n:
        return tasks

    groups = defaultdict(list)
    for t in tasks:
        diff = t["metadata"]["additional"]["difficulty"]
        groups[diff].append(t)

    selected = []
    domain_counts = defaultdict(int)

    group_keys = sorted(groups.keys())
    for key in group_keys:
        random.shuffle(groups[key])

    group_iters = {key: iter(groups[key]) for key in group_keys}

    while len(selected) < n:
        added_this_round = False
        for key in group_keys:
            if len(selected) >= n:
                break
            it = group_iters[key]
            for t in it:
                domain = t["metadata"]["website"]
                if domain_counts[domain] < 2:
                    selected.append(t)
                    domain_counts[domain] += 1
                    added_this_round = True
                    break
        if not added_this_round:
            remaining = [t for t in tasks if t not in selected]
            random.shuffle(remaining)
            for t in remaining:
                if len(selected) >= n:
                    break
                if t not in selected:
                    selected.append(t)

    return selected[:n]


def write_jsonl(tasks, path):
    with open(path, "w") as f:
        for t in tasks:
            f.write(json.dumps(t, ensure_ascii=False) + "\n")


def print_stats(name, tasks):
    cats = defaultdict(int)
    diffs = defaultdict(int)
    domains = set()
    for t in tasks:
        cats[t["metadata"].get("category", t["metadata"].get("additional", {}).get("topic", "?"))] += 1
        diff = t["metadata"].get("additional", {}).get("difficulty", "?")
        diffs[diff] += 1
        domains.add(t["metadata"].get("website", "?"))
    cat_str = ", ".join(f"{c}({n})" for c, n in sorted(cats.items(), key=lambda x: -x[1]))
    diff_str = ", ".join(f"{d}({n})" for d, n in sorted(diffs.items(), key=lambda x: -x[1]))
    print(f"  {name}: {len(tasks)} tasks | {len(domains)} websites")
    print(f"    difficulty: {diff_str}")
    if cat_str:
        print(f"    categories: {cat_str}")


# ══════════════════════════════════════════════════════════════════════
# PART 1: WebBench READ-only datasets
# ══════════════════════════════════════════════════════════════════════
print("=" * 60)
print("PART 1: WebBench READ-only datasets")
print("=" * 60)

print("\nLoading agents...")
agent_results = {}
for agent in AGENTS:
    agent_results[agent["key"]] = load_agent(agent)
    print(f"  {agent['key']}: {len(agent_results[agent['key']])} tasks")

all_ids = set(agent_results[AGENTS[0]["key"]].keys())
for agent in AGENTS[1:]:
    all_ids &= set(agent_results[agent["key"]].keys())

buckets = defaultdict(list)
skipped_non_read = 0
skipped_auth = 0

for tid in sorted(all_ids):
    info = agent_results[AGENTS[0]["key"]][tid]

    # READ-only filter
    if info["category"] != "READ":
        skipped_non_read += 1
        continue

    # Auth filter
    if needs_auth(info["task"]):
        skipped_auth += 1
        continue

    pass_count = 0
    agent_evals = {}
    for agent in AGENTS:
        r = agent_results[agent["key"]][tid]
        is_success = "success" in r["eval"].lower() if r["eval"] else False
        if is_success:
            pass_count += 1
        agent_evals[agent["key"]] = "PASS" if is_success else "FAIL"

    entry = build_task_entry(tid, info, pass_count, agent_evals)
    buckets[pass_count].append(entry)

print(f"\nFiltered: {skipped_non_read} non-READ, {skipped_auth} auth-required")
print("READ-only buckets:")
for pc in range(5):
    print(f"  {pc}/4: {len(buckets[pc])} tasks")

# Build 6 WebBench datasets
for pc in [0, 1, 2]:
    full = buckets[pc]
    sampled = stratified_sample(full, 50)

    full_path = os.path.join(OUT_DIR, f"webbench-{pc}of4.jsonl")
    sample_path = os.path.join(OUT_DIR, f"webbench-{pc}of4-50.jsonl")

    write_jsonl(full, full_path)
    write_jsonl(sampled, sample_path)

    print(f"\n{'─' * 40}")
    print_stats(f"webbench-{pc}of4 (full)", full)
    print_stats(f"webbench-{pc}of4-50 (sampled)", sampled)


# ══════════════════════════════════════════════════════════════════════
# PART 2: BrowseComp datasets
# ══════════════════════════════════════════════════════════════════════
print(f"\n{'=' * 60}")
print("PART 2: BrowseComp datasets")
print("=" * 60)

browsecomp_path = os.path.join(DATA_DIR, "browsecomp.csv")
if not os.path.exists(browsecomp_path):
    print(f"\n  Downloading BrowseComp dataset...")
    import urllib.request
    url = "https://openaipublic.blob.core.windows.net/simple-evals/browse_comp_test_set.csv"
    urllib.request.urlretrieve(url, browsecomp_path)
    print(f"  Saved to {browsecomp_path}")

# Load BrowseComp
bc_tasks = []
with open(browsecomp_path, newline="", encoding="utf-8") as f:
    reader = csv.DictReader(f)
    for i, row in enumerate(reader):
        topic = row.get("problem_topic", "Other")
        bc_tasks.append({
            "query_id": f"bc-{i}",
            "dataset": "browsecomp",
            "query": row.get("problem", ""),
            "start_url": "https://www.google.com/",
            "metadata": {
                "original_task_id": f"bc-{i}",
                "website": "google.com",
                "category": "information-retrieval",
                "additional": {
                    "topic": topic,
                    "answer_length": len(row.get("answer", "")),
                },
            },
        })

print(f"\nLoaded {len(bc_tasks)} BrowseComp tasks")

# Categorize difficulty by answer_length and query complexity
# Shorter answers + shorter queries = relatively easier
# Longer answers + longer queries = harder
for t in bc_tasks:
    query_len = len(t["query"])
    ans_len = t["metadata"]["additional"]["answer_length"]
    # Simple heuristic: longer query = more constraints = harder
    if query_len < 600 and ans_len < 50:
        t["metadata"]["additional"]["difficulty"] = "medium"
    elif query_len < 1000:
        t["metadata"]["additional"]["difficulty"] = "hard"
    else:
        t["metadata"]["additional"]["difficulty"] = "very-hard"

diffs = defaultdict(int)
for t in bc_tasks:
    diffs[t["metadata"]["additional"]["difficulty"]] += 1
print(f"Difficulty distribution: {dict(diffs)}")

# Topics
topics = defaultdict(int)
for t in bc_tasks:
    topics[t["metadata"]["additional"]["topic"]] += 1
print(f"Topics: {dict(topics)}")

# Build medium-hard set: sample from medium + hard
medium_hard_pool = [t for t in bc_tasks if t["metadata"]["additional"]["difficulty"] in ("medium", "hard")]
random.shuffle(medium_hard_pool)

# Stratify by topic
topic_groups = defaultdict(list)
for t in medium_hard_pool:
    topic_groups[t["metadata"]["additional"]["topic"]].append(t)

bc_medium_hard = []
topic_keys = sorted(topic_groups.keys())
for key in topic_keys:
    random.shuffle(topic_groups[key])

topic_iters = {key: iter(topic_groups[key]) for key in topic_keys}
while len(bc_medium_hard) < 50:
    added = False
    for key in topic_keys:
        if len(bc_medium_hard) >= 50:
            break
        try:
            bc_medium_hard.append(next(topic_iters[key]))
            added = True
        except StopIteration:
            continue
    if not added:
        break

# Build very-hard set: sample from very-hard + remaining hard
very_hard_pool = [t for t in bc_tasks if t["metadata"]["additional"]["difficulty"] == "very-hard"]
# Add hard tasks not already selected
hard_remaining = [t for t in bc_tasks if t["metadata"]["additional"]["difficulty"] == "hard" and t not in bc_medium_hard]
very_hard_pool.extend(hard_remaining)
random.shuffle(very_hard_pool)

topic_groups2 = defaultdict(list)
for t in very_hard_pool:
    topic_groups2[t["metadata"]["additional"]["topic"]].append(t)

bc_very_hard = []
topic_keys2 = sorted(topic_groups2.keys())
for key in topic_keys2:
    random.shuffle(topic_groups2[key])

topic_iters2 = {key: iter(topic_groups2[key]) for key in topic_keys2}
while len(bc_very_hard) < 50:
    added = False
    for key in topic_keys2:
        if len(bc_very_hard) >= 50:
            break
        try:
            bc_very_hard.append(next(topic_iters2[key]))
            added = True
        except StopIteration:
            continue
    if not added:
        break

# Write BrowseComp files
bc_mh_path = os.path.join(OUT_DIR, "browsecomp-medium-hard-50.jsonl")
bc_vh_path = os.path.join(OUT_DIR, "browsecomp-very-hard-50.jsonl")
write_jsonl(bc_medium_hard, bc_mh_path)
write_jsonl(bc_very_hard, bc_vh_path)

print(f"\n{'─' * 40}")
print_stats("browsecomp-medium-hard-50", bc_medium_hard)
print_stats("browsecomp-very-hard-50", bc_very_hard)

# ══════════════════════════════════════════════════════════════════════
# SUMMARY
# ══════════════════════════════════════════════════════════════════════
print(f"\n{'=' * 60}")
print("ALL FILES WRITTEN")
print("=" * 60)
files = [
    "webbench-0of4.jsonl", "webbench-0of4-50.jsonl",
    "webbench-1of4.jsonl", "webbench-1of4-50.jsonl",
    "webbench-2of4.jsonl", "webbench-2of4-50.jsonl",
    "browsecomp-medium-hard-50.jsonl", "browsecomp-very-hard-50.jsonl",
]
for f in files:
    path = os.path.join(OUT_DIR, f)
    with open(path) as fh:
        count = sum(1 for _ in fh)
    print(f"  {f}: {count} tasks")
