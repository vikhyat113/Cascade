"""Download walk + drive street networks with OSMnx, save GraphML, and export a
compact routing pack (gzipped JSON) that the backend loads without OSMnx.

    python scripts/fetch_graph.py [--force]
"""
from __future__ import annotations

import sys

import osmnx as ox

from common import CFG, DATA, RAW, get_area, utc_now_iso, write_json


def first(v):
    if isinstance(v, list):
        return v[0] if v else None
    return v


def parse_maxspeed(v):
    v = first(v)
    if v is None:
        return None
    try:
        return float(str(v).split()[0])
    except ValueError:
        return None


def export_pack(G, directed: bool, path):
    nodes = list(G.nodes)
    idx = {n: i for i, n in enumerate(nodes)}
    pack = {
        "generated_at": utc_now_iso(),
        "source": "OpenStreetMap contributors via OSMnx",
        "directed": directed,
        "nodes": {
            "id": [int(n) for n in nodes],
            "lat": [round(G.nodes[n]["y"], 6) for n in nodes],
            "lon": [round(G.nodes[n]["x"], 6) for n in nodes],
        },
        "edges": {k: [] for k in ("u", "v", "len", "hw", "lit", "name", "speed", "geom", "sidewalk", "footway", "surface")},
    }
    E = pack["edges"]
    for u, v, d in G.edges(data=True):
        E["u"].append(idx[u])
        E["v"].append(idx[v])
        E["len"].append(round(float(d.get("length", 0.0)), 1))
        E["hw"].append(first(d.get("highway")) or "unclassified")
        lit = first(d.get("lit"))
        E["lit"].append(str(lit).lower() if lit is not None else None)
        E["name"].append(first(d.get("name")))
        E["speed"].append(round(float(d["speed_kph"]), 1) if "speed_kph" in d else parse_maxspeed(d.get("maxspeed")))
        sw = first(d.get("sidewalk"))
        E["sidewalk"].append(str(sw).lower() if sw is not None else None)
        fw = first(d.get("footway"))
        E["footway"].append(str(fw).lower() if fw is not None else None)
        sf = first(d.get("surface"))
        E["surface"].append(str(sf).lower() if sf is not None else None)
        if "geometry" in d:
            coords = [[round(x, 6), round(y, 6)] for x, y in d["geometry"].coords]
        else:
            coords = [[pack["nodes"]["lon"][idx[u]], pack["nodes"]["lat"][idx[u]]],
                      [pack["nodes"]["lon"][idx[v]], pack["nodes"]["lat"][idx[v]]]]
        E["geom"].append(coords)
    print(f"  {path.name}: {len(nodes)} nodes, {len(E['u'])} edges")
    write_json(path, pack, compress=True)


def download(network_type: str):
    ox.settings.use_cache = True
    ox.settings.cache_folder = str(RAW / "osmnx_cache")
    ox.settings.http_user_agent = CFG["user_agent"]
    ox.settings.overpass_rate_limit = False
    ox.settings.requests_timeout = 300
    ox.settings.useful_tags_way = list(set(ox.settings.useful_tags_way + ["lit", "sidewalk", "footway", "surface"]))
    area = get_area()
    polygon = area.polygon if area is not None else None
    center = (CFG["center"]["lat"], CFG["center"]["lon"])
    last = None
    for url in CFG["overpass_urls"]:
        ox.settings.overpass_url = url.rsplit("/interpreter", 1)[0]
        try:
            if polygon is not None:
                print(f"  downloading {network_type} graph from polygon via {ox.settings.overpass_url}")
                return ox.graph_from_polygon(polygon, network_type=network_type, simplify=True)
            else:
                print(f"  downloading {network_type} graph via {ox.settings.overpass_url}")
                return ox.graph_from_point(center, dist=CFG["radius_m"], network_type=network_type, simplify=True)
        except Exception as e:
            last = e
            print(f"    failed: {e!r}")
    sys.exit(f"could not download graph: {last!r}")


def main():
    force = "--force" in sys.argv
    for nt in ("walk", "drive"):
        gml = RAW / f"{nt}.graphml"
        if gml.exists() and not force:
            print(f"  loading cached {gml.name}")
            G = ox.load_graphml(gml)
        else:
            G = download(nt)
            if nt == "drive":
                G = ox.add_edge_speeds(G)
                G = ox.add_edge_travel_times(G)
            ox.save_graphml(G, gml)
        if nt == "walk":
            G = ox.convert.to_undirected(G)
        export_pack(G, directed=(nt == "drive"), path=DATA / f"graph_{nt}.json.gz")


if __name__ == "__main__":
    main()
