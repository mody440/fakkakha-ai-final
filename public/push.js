// public/push.js
// Real push-notification client registration for the Capacitor-wrapped
// native app. Safe to load unconditionally: on plain web (no Capacitor
// shell), window.Capacitor doesn't exist and this whole module no-ops.
//
// Uses Capacitor's global `Capacitor.Plugins.X` namespace instead of an ES
// module import — that works without a bundler, since Capacitor exposes
// installed native plugins on `window.Capacitor` automatically once
// `@capacitor/push-notifications` is added to the native project (see
// CHECKLIST.md for the `npm install` + `npx cap sync` step).
//
// What's real and working right now: requesting permission, registering
// with the OS, and storing the resulting device token in Supabase.
// What still needs a manual account-setup step (in CHECKLIST.md, not
// deferred code): a Firebase project connected via Capacitor for the
// actual message delivery — this module can't send a notification to
// itself, only register to be able to receive one.

async function initPush(supabaseClient) {
  const Capacitor = window.Capacitor;
  if (!Capacitor || !Capacitor.isNativePlatform || !Capacitor.isNativePlatform()) return; // plain web/PWA — nothing to do

  const PushNotifications = Capacitor.Plugins && Capacitor.Plugins.PushNotifications;
  if (!PushNotifications) return; // plugin not installed in this native build yet

  try {
    const perm = await PushNotifications.requestPermissions();
    if (perm.receive !== 'granted') return;

    await PushNotifications.register();

    PushNotifications.addListener('registration', async (tokenResult) => {
      const { data: { session } } = await supabaseClient.auth.getSession();
      if (!session) return;
      await supabaseClient.from('push_tokens').upsert({
        user_id: session.user.id,
        token: tokenResult.value,
        platform: Capacitor.getPlatform ? Capacitor.getPlatform() : 'unknown'
      });
    });

    PushNotifications.addListener('registrationError', (err) => {
      console.error(JSON.stringify({ level: 'error', source: 'push', message: 'registration failed', err: String(err) }));
    });
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', source: 'push', message: 'init failed', err: String(err) }));
  }
}

if (typeof window !== 'undefined') window.initPush = initPush;
