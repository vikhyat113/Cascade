// Safety timer (spec §9): "Tell my contact if I'm late". A local notification at "Be there by" + 10 min
// asks "Are you home?"; no answer within a few minutes -> a (simulated) alert to the dispatch server's
// Contact desk, and the app offers the prefilled text message.
// Times are in the app clock (the demo can run it 10x / 60x), converted to real time for the notification.
import { LocalNotifications } from "@capacitor/local-notifications";
import { Preferences } from "@capacitor/preferences";
import { CONFIG } from "../config";

const KEY = "nw.safetyTimer";
const NOTE_ID = 4242;

export interface SafetyTimer { askAt: number; alertAt: number; answered: boolean; alerted: boolean; lat: number; lon: number }

/** Real-time moments for a deadline in app-clock time. A trip started after its deadline is asked
 *  about 10 min after the start, not straight away. */
export function timerTimes(deadline: number, appNow: number, speed: number, realNow = Date.now(), cfg = CONFIG.safetyTimer) {
  const k = speed > 0 ? speed : 1;
  const askAt = realNow + (Math.max(deadline, appNow) + cfg.afterDeadlineMin * 60000 - appNow) / k;
  return { askAt, alertAt: askAt + (cfg.answerWithinMin * 60000) / k };
}

export async function loadTimer(): Promise<SafetyTimer | null> {
  try { const { value } = await Preferences.get({ key: KEY }); return value ? (JSON.parse(value) as SafetyTimer) : null; } catch { return null; }
}
export async function saveTimer(t: SafetyTimer | null): Promise<void> {
  try { if (t) await Preferences.set({ key: KEY, value: JSON.stringify(t) }); else await Preferences.remove({ key: KEY }); } catch { /* ignore */ }
}

export async function armTimer(t: Omit<SafetyTimer, "answered" | "alerted">, words: { title: string; body: string }): Promise<SafetyTimer> {
  const timer: SafetyTimer = { ...t, answered: false, alerted: false };
  await saveTimer(timer);
  try {
    const p = await LocalNotifications.requestPermissions();
    if (p.display === "granted") {
      await LocalNotifications.cancel({ notifications: [{ id: NOTE_ID }] }).catch(() => {});
      await LocalNotifications.schedule({ notifications: [{ id: NOTE_ID, title: words.title, body: words.body, schedule: { at: new Date(timer.askAt), allowWhileIdle: true } }] });
    }
  } catch { /* no notifications (web / denied): the in-app check still asks */ }
  return timer;
}

export async function disarmTimer(): Promise<void> {
  await saveTimer(null);
  try { await LocalNotifications.cancel({ notifications: [{ id: NOTE_ID }] }); } catch { /* ignore */ }
}

/** Tapping the notification opens the app on the question. */
export function onTimerTapped(f: () => void): () => void {
  let remove = () => {};
  LocalNotifications.addListener("localNotificationActionPerformed", (e) => { if (e.notification.id === NOTE_ID) f(); })
    .then((h) => { remove = () => void h.remove(); }).catch(() => {});
  return () => remove();
}

/** Demo: make a running safety timer ask now (and alert 20 s later if nobody answers). */
export async function fireTimerSoon(): Promise<boolean> {
  const t = await loadTimer();
  if (!t) return false;
  const now = Date.now();
  await saveTimer({ ...t, askAt: now, alertAt: now + 20000, answered: false, alerted: false });
  return true;
}
