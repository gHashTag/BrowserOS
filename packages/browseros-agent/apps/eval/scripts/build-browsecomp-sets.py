"""
Build BrowseComp eval datasets (decrypted, 2 difficulty tiers).
Decryption uses XOR with the canary field as key (from OpenAI's simple-evals).

Usage: python3 apps/eval/scripts/build-browsecomp-sets.py
"""
import base64
import csv
import hashlib
import json
import os
import random
import urllib.request
from collections import defaultdict

random.seed(42)

OUT_DIR = "apps/eval/data"
BC_URL = "https://openaipublic.blob.core.windows.net/simple-evals/browse_comp_test_set.csv"
BC_CACHE = "apps/eval/data/webbench/browsecomp.csv"


def derive_key(password: str, length: int) -> bytes:
    hasher = hashlib.sha256()
    hasher.update(password.encode())
    key = hasher.digest()
    return key * (length // len(key)) + key[: length % len(key)]


def decrypt(ciphertext_b64: str, password: str) -> str:
    encrypted = base64.b64decode(ciphertext_b64)
    key = derive_key(password, len(encrypted))
    decrypted = bytes(a ^ b for a, b in zip(encrypted, key))
    return decrypted.decode()


def stratified_sample_by_topic(tasks, n):
    """Round-robin sample across topics for diversity."""
    groups = defaultdict(list)
    for t in tasks:
        groups[t["metadata"]["additional"]["topic"]].append(t)

    for key in groups:
        random.shuffle(groups[key])

    selected = []
    topic_keys = sorted(groups.keys())
    iters = {k: iter(groups[k]) for k in topic_keys}

    while len(selected) < n:
        added = False
        for key in topic_keys:
            if len(selected) >= n:
                break
            try:
                selected.append(next(iters[key]))
                added = True
            except StopIteration:
                continue
        if not added:
            break

    return selected


# Download if needed
if not os.path.exists(BC_CACHE):
    print("Downloading BrowseComp dataset...")
    urllib.request.urlretrieve(BC_URL, BC_CACHE)

# Load and decrypt
tasks = []
with open(BC_CACHE, newline="", encoding="utf-8") as f:
    for i, row in enumerate(csv.DictReader(f)):
        canary = row["canary"]
        problem = decrypt(row["problem"], canary)
        answer = decrypt(row["answer"], canary)
        topic = row["problem_topic"]
        query_len = len(problem)

        # Difficulty based on query length (more constraints = harder)
        if query_len < 450:
            difficulty = "medium"
        elif query_len < 700:
            difficulty = "hard"
        else:
            difficulty = "very-hard"

        tasks.append({
            "query_id": f"bc-{i}",
            "dataset": "browsecomp",
            "query": problem,
            "start_url": "https://www.google.com/",
            "metadata": {
                "original_task_id": f"bc-{i}",
                "website": "google.com",
                "category": "information-retrieval",
                "additional": {
                    "topic": topic,
                    "difficulty": difficulty,
                    "answer": answer,
                },
            },
        })

print(f"Loaded {len(tasks)} BrowseComp tasks (decrypted)")

# Difficulty distribution
diffs = defaultdict(int)
for t in tasks:
    diffs[t["metadata"]["additional"]["difficulty"]] += 1
print(f"Difficulty: {dict(sorted(diffs.items()))}")

# Topic distribution
topics = defaultdict(int)
for t in tasks:
    topics[t["metadata"]["additional"]["topic"]] += 1
print(f"Topics: {dict(sorted(topics.items()))}")

# Build medium-hard set: medium + hard tasks
mh_pool = [t for t in tasks if t["metadata"]["additional"]["difficulty"] in ("medium", "hard")]
bc_medium_hard = stratified_sample_by_topic(mh_pool, 50)

# Build very-hard set: very-hard + remaining hard tasks
vh_pool = [t for t in tasks if t["metadata"]["additional"]["difficulty"] == "very-hard"]
hard_remaining = [t for t in tasks if t["metadata"]["additional"]["difficulty"] == "hard" and t not in bc_medium_hard]
vh_pool.extend(hard_remaining)
bc_very_hard = stratified_sample_by_topic(vh_pool, 50)

# Write files
def write_jsonl(data, path):
    with open(path, "w") as f:
        for t in data:
            f.write(json.dumps(t, ensure_ascii=False) + "\n")


mh_path = os.path.join(OUT_DIR, "browsecomp-medium-hard-50.jsonl")
vh_path = os.path.join(OUT_DIR, "browsecomp-very-hard-50.jsonl")
write_jsonl(bc_medium_hard, mh_path)
write_jsonl(bc_very_hard, vh_path)

# Print stats
for name, data in [("browsecomp-medium-hard-50", bc_medium_hard), ("browsecomp-very-hard-50", bc_very_hard)]:
    diffs = defaultdict(int)
    topics = defaultdict(int)
    for t in data:
        diffs[t["metadata"]["additional"]["difficulty"]] += 1
        topics[t["metadata"]["additional"]["topic"]] += 1
    print(f"\n{name}: {len(data)} tasks")
    print(f"  difficulty: {dict(sorted(diffs.items()))}")
    print(f"  topics: {dict(sorted(topics.items()))}")
    # Show first 2 samples
    for t in data[:2]:
        print(f"  [{t['query_id']}] {t['metadata']['additional']['topic']}")
        print(f"    Q: {t['query'][:150]}")
        print(f"    A: {t['metadata']['additional']['answer']}")
