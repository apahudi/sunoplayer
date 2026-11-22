(() => {
  const buttons = [...document.querySelectorAll('[data-push-toggle]')];
  if (!buttons.length) return;

  const supported = window.isSecureContext
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window;

  function setSubscribed(subscribed) {
    const label = subscribed ? 'Matikan notifikasi lagu baru' : 'Aktifkan notifikasi lagu baru';
    buttons.forEach((button) => {
      button.setAttribute('aria-pressed', String(subscribed));
      button.setAttribute('aria-label', label);
      button.title = label;
    });
  }

  function announce(message, error = false) {
    document.querySelectorAll('[data-push-status]').forEach((status) => {
      status.textContent = message;
      status.dataset.type = error ? 'error' : 'success';
      status.hidden = false;
    });
    window.dispatchEvent(new CustomEvent('budijoi:push-status', { detail: { message, error } }));
  }

  function setBusy(busy) {
    buttons.forEach((button) => { button.disabled = busy; });
  }

  async function responseData(response) {
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error('Respons server notifikasi tidak valid.');
    }
    if (!response.ok) throw new Error(data.error || 'Pengaturan notifikasi gagal disimpan.');
    return data;
  }

  async function currentSubscription() {
    const registration = await navigator.serviceWorker.getRegistration('/');
    return registration ? registration.pushManager.getSubscription() : null;
  }

  async function refresh() {
    if (!supported) {
      buttons.forEach((button) => { button.hidden = true; });
      return;
    }
    if (Notification.permission === 'denied') {
      setSubscribed(false);
      return;
    }
    try {
      setSubscribed(Boolean(await currentSubscription()));
    } catch (error) {
      console.error('Gagal memeriksa langganan notifikasi:', error);
    }
  }

  function applicationServerKey(value) {
    const padded = value + '='.repeat((4 - value.length % 4) % 4);
    const decoded = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  }

  async function toggleSubscription() {
    if (!supported) return;
    setBusy(true);
    try {
      if (Notification.permission === 'denied') {
        announce('Notifikasi diblokir. Ubah izin notifikasi situs ini di pengaturan browser.', true);
        return;
      }

      const existing = await currentSubscription();
      if (existing) {
        await responseData(await fetch('/api/push/subscriptions', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: existing.endpoint }),
        }));
        await existing.unsubscribe();
        setSubscribed(false);
        announce('Notifikasi lagu baru dimatikan.');
        return;
      }

      let permission = Notification.permission;
      if (permission !== 'granted') permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        announce(
          permission === 'denied'
            ? 'Notifikasi diblokir. Ubah izin notifikasi situs ini di pengaturan browser.'
            : 'Izin notifikasi belum diberikan.',
          true
        );
        return;
      }

      const registration = await navigator.serviceWorker.register('/service-worker.js', { scope: '/' });
      const keyResponse = await fetch('/api/push/public-key', { cache: 'no-store' });
      const { publicKey } = await responseData(keyResponse);
      if (typeof publicKey !== 'string' || !publicKey) {
        throw new Error('Kunci notifikasi tidak tersedia.');
      }

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey(publicKey),
      });
      try {
        await responseData(await fetch('/api/push/subscriptions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(subscription.toJSON()),
        }));
      } catch (error) {
        try {
          await subscription.unsubscribe();
        } catch (cleanupError) {
          console.error('Gagal membersihkan langganan push yang tidak tersimpan:', cleanupError);
        }
        throw error;
      }
      setSubscribed(true);
      announce('Notifikasi lagu baru aktif di browser ini.');
    } catch (error) {
      console.error('Gagal mengatur notifikasi lagu baru:', error);
      announce(error.message || 'Notifikasi lagu baru gagal diatur.', true);
    } finally {
      setBusy(false);
    }
  }

  buttons.forEach((button) => button.addEventListener('click', toggleSubscription));
  refresh();
})();
