import json
import math
import random
from pathlib import Path

random.seed(42)

BASE_DIR = Path(__file__).resolve().parent.parent
OUTPUT = BASE_DIR / "data" / "city" / "default_city.json"

LAT_SCALE = 111_320.0
LNG_MIN, LNG_MAX = 14.410, 14.440
LAT_MIN, LAT_MAX = 50.083, 50.090


def approx_distance_m(x1, y1, x2, y2):
    mean_lat = (y1 + y2) / 2.0
    lon_scale = 111_320.0 * max(0.1, math.cos(math.radians(mean_lat)))
    dx = (x2 - x1) * lon_scale
    dy = (y2 - y1) * LAT_SCALE
    return max(5.0, math.sqrt(dx * dx + dy * dy))


rows = 5
cols = 5
lng_step = (LNG_MAX - LNG_MIN) / (cols - 1)
lat_step = (LAT_MAX - LAT_MIN) / (rows - 1)

nodes = []
for r in range(rows):
    for c in range(cols):
        idx = r * cols + c + 1
        x = round(LNG_MIN + c * lng_step + random.uniform(-0.001, 0.001), 4)
        y = round(LAT_MIN + r * lat_step + random.uniform(-0.0005, 0.0005), 4)
        nodes.append({"node_id": f"n{idx}", "x": x, "y": y})

node_by_id = {n["node_id"]: n for n in nodes}


def rc_to_idx(r, c):
    return r * cols + c + 1


edge_pairs = []

for r in range(rows):
    for c in range(cols):
        nid = f"n{rc_to_idx(r, c)}"
        if c + 1 < cols:
            right = f"n{rc_to_idx(r, c + 1)}"
            edge_pairs.append((nid, right))
            if random.random() < 0.35:
                edge_pairs.append((right, nid))
        if r + 1 < rows:
            down = f"n{rc_to_idx(r + 1, c)}"
            edge_pairs.append((nid, down))
            if random.random() < 0.30:
                edge_pairs.append((down, nid))

diagonals = [
    (0, 0, 1, 1), (2, 2, 3, 3), (0, 4, 1, 3), (2, 1, 3, 2),
    (0, 2, 1, 3), (3, 2, 4, 1),
]
for r1, c1, r2, c2 in diagonals:
    src = f"n{rc_to_idx(r1, c1)}"
    tgt = f"n{rc_to_idx(r2, c2)}"
    if random.random() < 0.5:
        edge_pairs.append((src, tgt))
        edge_pairs.append((tgt, src))
    else:
        edge_pairs.append((src, tgt))

required = [
    ("n1", "n2"),
    ("n2", "n3"),
    ("n2", "n7"),
    ("n7", "n2"),
]
for req_src, req_tgt in required:
    if (req_src, req_tgt) not in edge_pairs:
        edge_pairs.append((req_src, req_tgt))

edges = []
seen_pairs = set()
for src, tgt in edge_pairs:
    key = (src, tgt)
    if key in seen_pairs:
        continue
    seen_pairs.add(key)
    s = node_by_id[src]
    t = node_by_id[tgt]
    dist = round(approx_distance_m(s["x"], s["y"], t["x"], t["y"]))
    lanes = random.choice([1, 1, 2, 2, 3])
    speed = random.choice([30, 35, 40, 45, 50, 55, 60])
    capacity = max(2, lanes * random.choice([8, 10, 12]))
    quality = round(random.uniform(0.7, 0.98), 2)
    edges.append({
        "edge_id": "",
        "source": src,
        "target": tgt,
        "distance_m": dist,
        "lanes": lanes,
        "base_speed_kph": speed,
        "capacity_per_minute": capacity,
        "quality": quality,
    })

required_map = {
    ("n1", "n2"): "e1",
    ("n2", "n3"): "e2",
    ("n2", "n7"): "e6",
    ("n7", "n2"): "e7",
}
assigned_ids = set()
for e in edges:
    pair = (e["source"], e["target"])
    if pair in required_map:
        e["edge_id"] = required_map[pair]
        assigned_ids.add(e["edge_id"])

next_id = 1
for e in edges:
    if e["edge_id"]:
        continue
    while f"e{next_id}" in assigned_ids:
        next_id += 1
    e["edge_id"] = f"e{next_id}"
    assigned_ids.add(e["edge_id"])
    next_id += 1

building_specs = [
    ("n1", "home", 1500),
    ("n6", "home", 1200),
    ("n11", "home", 1800),
    ("n16", "home", 1400),
    ("n21", "home", 1600),
    ("n3", "work", 1400),
    ("n8", "work", 1200),
    ("n13", "work", 1600),
    ("n18", "work", 1100),
    ("n4", "school", 800),
    ("n9", "school", 700),
    ("n19", "school", 900),
    ("n2", "leisure", 900),
    ("n7", "leisure", 850),
    ("n12", "leisure", 1000),
    ("n17", "leisure", 750),
    ("n22", "leisure", 800),
    ("n25", "leisure", 950),
    ("n5", "home", 1100),
    ("n10", "work", 1300),
]

buildings = []
for i, (nid, kind, cap) in enumerate(building_specs):
    buildings.append({
        "building_id": f"b_{kind}_{i + 1}",
        "node_id": nid,
        "kind": kind,
        "capacity": cap,
    })

city = {
    "nodes": nodes,
    "edges": edges,
    "buildings": buildings,
}

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
with open(OUTPUT, "w", encoding="utf-8") as f:
    json.dump(city, f, indent=2)

print(f"Generated {len(nodes)} nodes, {len(edges)} edges, {len(buildings)} buildings")
print(f"Written to {OUTPUT}")
