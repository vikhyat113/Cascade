"""Download walk + drive street networks with OSMnx, save GraphML, and export a
compact routing pack (gzipped JSON) that the backend loads without OSMnx.

    python scripts/fetch_graph.py [--force]
"""
from __future__ import annotations

import sys

import osmnx as ox

import area
from common import CFG, DATA, RAW, utc_now_iso, write_json


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
        "edges": {k: [] for k in ("u", "v", "len", "hw", "lit", "name", "speed", "geom")},
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
        if "geometry" in d:
            coords = [[round(x, 6), round(y, 6)] for x, y in d["geometry"].coords]
        else:
            coords = [[pack["nodes"]["lon"][idx[u]], pack["nodes"]["lat"][idx[u]]],
                      [pack["nodes"]["lon"][idx[v]], pack["nodes"]["lat"][idx[v]]]]
        E["geom"].append(coords)
    print(f"  {path.name}: {len(nodes)} nodes, {len(E['u'])} edges")
    write_json(path, pack, compress=True)


def _setup():
    ox.settings.use_cache = True
    ox.settings.cache_folder = str(RAW / "osmnx_cache")
    ox.settings.http_user_agent = CFG["user_agent"]
    ox.settings.overpass_rate_limit = False
    ox.settings.requests_timeout = 300
    ox.settings.useful_tags_way = list(set(ox.settings.useful_tags_way + ["lit", "sidewalk"]))


def _from_polygon(poly, **kw):
    last = None
    for url in CFG["overpass_urls"]:
        ox.settings.overpass_url = url.rsplit("/interpreter", 1)[0]
        try:
            return ox.graph_from_polygon(poly, simplify=False, retain_all=True, **kw)
        except Exception as e:
            last = e
            print(f"    failed via {ox.settings.overpass_url}: {e!r}")
    sys.exit(f"could not download graph: {last!r}")


def download(network_type: str):
    """Zones with detail=full get the whole network; the corridor only its major roads (UPGRADE §2).
    Downloaded unsimplified, joined (shared OSM node ids connect them), then simplified once."""
    import networkx as nx

    _setup()
    major = CFG["area"]["corridor"]["major_highways"]
    parts = []
    for props, poly in area.polygons():
        if props["detail"] == "full":
            print(f"  {network_type}: {props['name']} (full detail)")
            parts.append(_from_polygon(poly, network_type=network_type))
        else:
            print(f"  {network_type}: {props['name']} (major roads only)")
            parts.append(_from_polygon(poly, custom_filter=f'["highway"~"^({major})$"]'))
    G = nx.compose_all(parts)
    G = ox.simplify_graph(G)
    G = ox.truncate.largest_component(G, strongly=False)   # the zones must connect through the corridor
    print(f"  {network_type}: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges after joining")
    return G


DRIVABLE = {"motorway", "motorway_link", "trunk", "trunk_link", "primary", "primary_link", "secondary", "secondary_link",
            "tertiary", "tertiary_link", "residential", "unclassified", "living_street", "service", "road"}


def drive_from_walk(W):
    """Car roads taken from the walk download (no second Overpass query: fair use, and the servers
    are often at capacity). Only the Python reference backend and the bus-route builder use it."""
    keep = [(u, v, k) for u, v, k, d in W.edges(keys=True, data=True)
            if (first(d.get("highway")) or "") in DRIVABLE and d.get("access") not in ("no", "private")]
    G = W.edge_subgraph(keep).copy()
    G = ox.truncate.largest_component(G, strongly=False)
    G = ox.add_edge_speeds(G)
    return ox.add_edge_travel_times(G)


def main():
    force = "--force" in sys.argv
    gml = RAW / "walk.graphml"
    if gml.exists() and not force:
        print(f"  loading cached {gml.name}")
        W = ox.load_graphml(gml)
    else:
        W = download("walk")
        ox.save_graphml(W, gml)
    export_pack(ox.convert.to_undirected(W), directed=False, path=DATA / "graph_walk.json.gz")
    D = drive_from_walk(W)
    print(f"  drive (from walk): {D.number_of_nodes()} nodes, {D.number_of_edges()} edges")
    export_pack(D, directed=True, path=DATA / "graph_drive.json.gz")


if __name__ == "__main__":
    main()
