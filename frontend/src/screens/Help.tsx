import { useEffect, useState } from "react";
import { useT, type CopyKey } from "../copy";
import { PLACE_ICON } from "../components/icons";
import { BigButton, QuietButton } from "../components/ui";
import { call } from "../lib/engine";
import { askForHelp, mapLink, smsHref, useHelp } from "../sos";
import type { HelpStatus } from "../sos/ladder";
import type { SosType } from "../sos/types";
import type { Place, PlaceOnWay } from "../types";

const STATUS: Record<HelpStatus, { icon: string; key: CopyKey; color: string }> = {
  sending: { icon: "⏳", key: "label.sending", color: "text-soft" },
  passed_on: { icon: "📨", key: "label.passedOn", color: "text-accent" },
  aware: { icon: "✅", key: "label.helpAware", color: "text-good" },
  not_sure: { icon: "❔", key: "label.notSure", color: "text-warn" },
};
const CHOICES: { type: SosType; icon: string; key: CopyKey }[] = [
  { type: "danger", icon: "🚨", key: "cta.danger" },
  { type: "medical", icon: "🩺", key: "cta.doctor" },
  { type: "unsure", icon: "❓", key: "label.notSure" },
];

function Overlay({ children, onClose, label }: { children: React.ReactNode; onClose: () => void; label: string }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60" onClick={onClose}>
      <div className="scroll-quiet max-h-[92dvh] w-full max-w-[480px] space-y-2.5 overflow-y-auto rounded-t-3xl bg-surface p-5"
        onClick={(e) => e.stopPropagation()} role="dialog" aria-label={label}>
        {children}
      </div>
    </div>
  );
}

const Call112 = () => {
  const { t } = useT();
  return <a href="tel:112" className="flex min-h-14 w-full items-center justify-center rounded-2xl bg-help text-[1.25rem] font-bold text-white">📞 {t("label.call112")}</a>;
};

export function TextContact({ at, late = false }: { at: Place; late?: boolean }) {
  const { t } = useT();
  const body = t(late ? "fmt.smsLate" : "fmt.smsHelp", { link: mapLink(at.lat, at.lon) });
  return (
    <a href={smsHref(body)} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border border-edge bg-raised px-4 font-semibold text-ink">
      💬 {t("label.textContact")}
    </a>
  );
}

/** Help (spec §9): three big choices, then plain progress. Call 112 and Text my contact always visible. */
export function HelpSheet({ at, onClose, onGo }: { at: Place; onClose: () => void; onGo: (p: PlaceOnWay) => void }) {
  const { t, lang } = useT();
  const help = useHelp();
  const [again, setAgain] = useState(false);          // a new request after the last one finished
  const choosing = !help || again;
  const [near, setNear] = useState<{ hospital: PlaceOnWay | null; police: PlaceOnWay | null } | null>(null);
  useEffect(() => { call("help", at.lat, at.lon).then(setNear).catch(() => setNear({ hospital: null, police: null })); }, [at, lang]);

  const st = help ? STATUS[help.status] : null;
  const target = help && help.target !== "contact" ? near?.[help.target] ?? null : null;
  return (
    <Overlay onClose={onClose} label={t("label.help")}>
      <h2 className="text-[1.4rem] font-bold">🆘 {t("label.help")}</h2>
      <Call112 />
      {choosing && CHOICES.map((c) => (
        <button key={c.type} onClick={() => { setAgain(false); askForHelp(c.type, at); }}
          className="flex min-h-16 w-full items-center gap-3 rounded-2xl border-2 border-help/70 bg-raised px-4 text-left text-[1.3rem] font-bold">
          <span aria-hidden="true" className="text-[1.6rem]">{c.icon}</span>{t(c.key)}
        </button>
      ))}
      {!choosing && help && st && (
        <div className="rounded-2xl bg-raised p-4" aria-live="polite">
          <p className={`text-[1.6rem] font-bold ${st.color}`}><span aria-hidden="true">{st.icon} </span>{t(st.key)}</p>
          {help.target !== "contact" && help.status !== "aware" && <p className="mt-1 text-[1.1rem]">{t("fmt.asking", { who: t(help.target === "police" ? "label.police" : "label.hospital") })}</p>}
          {help.escalated && help.status !== "aware" && <p className="mt-1 text-warn">{t("line.noAnswerNext")}</p>}
          {help.via === "mesh" && <p className="mt-1 text-soft">{t("line.viaPhones")}</p>}
          {help.status === "not_sure" && <p className="mt-1 font-semibold text-warn">{t("line.call112Now")}</p>}
          {target && (
            <div className="mt-3 flex items-center gap-3">
              <span aria-hidden="true" className="text-[1.5rem]">{PLACE_ICON[target.type]}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[1.1rem] font-bold">{target.name}</p>
                <p className="text-soft">{target.distance_text}</p>
              </div>
              {target.phone && <a href={`tel:${target.phone}`} className="flex min-h-12 items-center rounded-xl border border-edge px-4 font-bold">📞 {t("label.call")}</a>}
              <button onClick={() => onGo(target)} className="min-h-12 rounded-xl bg-accent px-4 font-bold text-accent-ink">{t("label.go")}</button>
            </div>
          )}
        </div>
      )}
      {!choosing && help && (help.status === "aware" || help.status === "not_sure") && (
        <QuietButton className="w-full" onClick={() => setAgain(true)}>🆘 {t("label.needHelp")}</QuietButton>
      )}
      <TextContact at={at} />
      <QuietButton className="w-full" onClick={onClose}>{t("label.close")}</QuietButton>
    </Overlay>
  );
}

/** Safety timer question: "Are you home?", and after no answer, the text to the contact. */
export function SafetySheet({ at, late, onHome, onHelp }: { at: Place; late: boolean; onHome: () => void; onHelp: () => void }) {
  const { t } = useT();
  return (
    <Overlay onClose={() => {}} label={t("line.areYouHome")}>
      <h2 className="text-[1.6rem] font-bold">🏠 {t("line.areYouHome")}</h2>
      {late && <p className="text-[1.1rem] font-semibold text-warn">{t("line.lateText")}</p>}
      {late && <TextContact at={at} late />}
      <BigButton onClick={onHome}>{t("label.imHome")}</BigButton>
      <BigButton tone="help" onClick={onHelp}>🆘 {t("label.needHelp")}</BigButton>
    </Overlay>
  );
}
