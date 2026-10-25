import { ScenariosTable } from "./ScenariosTable";

/** /scenarios: the stress-harness results on their own page (judges). */
export default function ScenariosPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-3 p-4">
      <a href="/" className="text-accent underline-offset-4 hover:underline">← back</a>
      <h1 className="text-[1.6rem] font-bold">Scenario results</h1>
      <p className="text-soft">
        Eight deterministic replays (seeded, simulated clock). Every output is validated: an UNKNOWN fact never carries a
        value, ranges are ordered, and the plain view never uses a banned word.
      </p>
      <div className="rounded-2xl border border-edge bg-surface p-4"><ScenariosTable /></div>
    </div>
  );
}
