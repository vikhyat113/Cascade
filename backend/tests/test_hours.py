from datetime import datetime

from app.core.hours import parse

MON_0230 = datetime(2026, 10, 26, 2, 30)   # a Monday
SAT_0230 = datetime(2026, 10, 31, 2, 30)


def test_24_7():
    oh = parse("24/7")
    assert oh.always and oh.is_open(MON_0230)


def test_simple_daily_range_closed_at_night():
    oh = parse("Mo-Su 11:00-23:00")
    assert not oh.is_open(MON_0230)
    assert oh.is_open(datetime(2026, 10, 26, 12, 0))


def test_range_past_midnight_uses_previous_day():
    oh = parse("Mo-Fr 08:30-05:00")
    assert oh.is_open(datetime(2026, 10, 27, 2, 30))     # Tue 02:30 <- Mon evening shift
    assert not oh.is_open(MON_0230)                      # Mon 02:30 <- Sunday not listed
    assert not oh.is_open(SAT_0230.replace(day=1, month=11))  # Sun 02:30 <- Sat not listed


def test_multiple_ranges_and_rules_override():
    oh = parse("Mo-Su 06:00-14:00,16:00-21:00")
    assert oh.is_open(datetime(2026, 10, 26, 13, 0)) and not oh.is_open(datetime(2026, 10, 26, 15, 0))
    oh2 = parse("Mo-Fr 09:00-17:00; We off; PH closed")
    assert not oh2.is_open(datetime(2026, 10, 28, 10, 0))   # Wednesday overridden
    assert oh2.is_open(datetime(2026, 10, 29, 10, 0))


def test_garbage_fails_gracefully():
    for raw in (None, "", "sunrise-sunset", "Mo-Fr 10:00+", "by appointment", "Jan-Mar 10:00-12:00"):
        assert parse(raw) is None


def test_next_change():
    oh = parse("Mo-Su 06:00-23:00")
    nc = oh.next_change(MON_0230)
    assert nc.hour == 6 and nc.minute == 0
