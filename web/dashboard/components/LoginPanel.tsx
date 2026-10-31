import { useApp } from '../context';

export function LoginPanel() {
  const { api, flags, guard } = useApp();
  const start = async () => {
    const { authUrl } = await api.post<{ authUrl: string }>('/auth/plex/start', {
      forwardUrl: `${window.location.origin}${window.location.pathname}`,
    });
    window.location.href = authUrl;
  };
  return (
    <section id="login">
      <img class="login-logo" src={`${flags.assetBase}/images/logo.png`} alt="" width={500} height={483} />
      <h2>Sign in</h2>
      <p class="hint">Use the Plex account you use with Seerr. Your Plex password is never seen by this app.</p>
      <button type="button" onClick={guard(start)}>Sign in with Plex</button>
    </section>
  );
}
