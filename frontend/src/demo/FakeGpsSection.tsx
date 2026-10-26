import { fakeGps, useFakeGps } from "../lib/position";
import type { SimpleView } from "../types";

/** Demo drawer: a fake GPS walking the current way, and "Wander off", to show the deviation warning in daytime. */
export function FakeGpsSection({ view }: { view: SimpleView | null }) {
  const on = useFakeGps();
  const opt = view?.options.find((o) => o.id === view.current_option_id) ?? null;
  const started = !!view?.current_option_id && !!view?.trip;
  const Btn = ({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) => (
    <button onClick={onClick} disabled={disabled} className="min-h-12 rounded-2xl border border-edge bg-raised px-3 font-semibold disabled:opacity-40">{label}</button>
  );
  return (
    <div className="space-y-2">
      <p className="text-[0.9rem] text-soft">
        SIMULATED location: replaces GPS for the trip so judges can see the “off the way” warnings and “New way”. A real trip that starts from a real GPS fix uses the phone's GPS.
        {!started && " Start a trip first."}
      </p>
      <div className="grid grid-cols-2 gap-2">
        <Btn label="Walk the way 1×" disabled={!started || !opt} onClick={() => opt && fakeGps.walk(opt.path, 1)} />
        <Btn label="Walk the way 10×" disabled={!started || !opt} onClick={() => opt && fakeGps.walk(opt.path, 10)} />
        <Btn label="Wander off 80 m" disabled={!on} onClick={() => fakeGps.wander(80)} />
        <Btn label="Wander off 300 m" disabled={!on} onClick={() => fakeGps.wander(300)} />
        <Btn label="Back on the way" disabled={!on} onClick={() => fakeGps.wander(0)} />
        <Btn label="Stop fake GPS" disabled={!on} onClick={() => fakeGps.stop()} />
      </div>
      <p className="text-[0.85rem]">Fake GPS: <b className={on ? "text-warn" : "text-soft"}>{on ? `ON (simulated), ${fakeGps.offsetM()} m off the way` : "off"}</b></p>
    </div>
  );
}
