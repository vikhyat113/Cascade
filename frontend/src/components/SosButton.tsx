import { useT } from "../copy";

/** The SOS button (UPGRADE §6): on every screen, top-right, above every sheet, banner, dialog and the
 *  map. One tap opens Help at once; the choice of what kind of help is made inside the sheet. It is not
 *  hidden by any flag. */
export function SosButton({ onPress }: { onPress: () => void }) {
  const { t } = useT();
  return (
    <button onClick={onPress} aria-label={t("label.sosLong")} data-sos
      className="fixed right-3 z-[90] flex h-14 min-w-14 items-center justify-center gap-1 rounded-2xl bg-help px-3 text-[1.15rem] font-extrabold text-white shadow-xl ring-2 ring-ink/70"
      style={{ top: "max(0.75rem, env(safe-area-inset-top))" }}>
      <span aria-hidden="true">🆘</span>{t("label.sos")}
    </button>
  );
}
