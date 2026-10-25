import numpy as np

from app.core.risk import CI, assess_weather, edge_risk
from app.core.sim import events
from app.core.world import CODE


def test_lighting_known_on_lit_ring_unknown_inside(tiny_static):
    S, G = tiny_static.walk_static, tiny_static.walk
    ring = np.array([h == "primary" for h in G.ehw])
    assert (S.light_code[ring] == CODE["KNOWN"]).all()
    assert (S.light_code[~ring] == CODE["UNKNOWN"]).all()
    # UNKNOWN lighting is an interval, and a wider one than KNOWN lighting
    assert (S.light_hi[~ring] - S.light_lo[~ring]).min() > (S.light_hi[ring] - S.light_lo[ring]).max()


def test_edge_risk_intervals_are_ordered_and_bounded(engine):
    er = edge_risk(engine.state, "walk", engine.state.now(), engine.cache)
    assert er.lo.shape == er.hi.shape
    assert (er.lo <= er.hi + 1e-12).all()
    assert er.lo.min() >= 0 and er.hi.max() <= 1


def test_unknown_weather_is_wide_interval_not_a_value(engine):
    s = engine.state
    events.set_source(s, "weather_live", False)
    events.set_source(s, "weather_forecast", False)
    engine.advance(900 * 11)                     # live observation ages past usability
    w = assess_weather(s, s.now())
    assert w.view.status == "UNKNOWN" and w.view.value is None
    assert (w.lo, w.hi) == (0.0, 0.7)


def test_dead_incident_feed_widens_incident_risk(engine):
    s = engine.state
    before = edge_risk(s, "walk", s.now(), engine.cache).hi[CI["incident"]].copy()
    events.set_source(s, "incident_reports", False)
    engine.advance(600 * 4)
    after = edge_risk(s, "walk", s.now(), engine.cache).hi[CI["incident"]]
    assert (after >= before - 1e-9).all() and after.mean() > before.mean()


def test_closure_blocks_drive_edges(engine):
    s = engine.state
    lat, lon = s.static.center
    events.add_closure(s, lat, lon, name="Ring Road", radius=2000)
    engine.advance(60)
    er = edge_risk(s, "drive", s.now(), engine.cache)
    assert er.blocked.any()
    assert all(s.static.drive.ename[e] == "Ring Road" for e in np.nonzero(er.blocked)[0])
